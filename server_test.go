package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testViewer(t *testing.T) (*app, http.Handler) {
	t.Helper()
	assets, err := fs.Sub(webFiles, "web")
	if err != nil {
		t.Fatal(err)
	}
	a := newApp(t.TempDir(), assets)
	t.Cleanup(a.close)
	return a, a.handler()
}

func localRequest(h http.Handler, method, path string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:8765"+path, nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// Stream multipart bodies so the optional real-demo test never buffers the
// uploaded match a second time in memory.
func demoRequest(url, name string, content io.Reader) *http.Request {
	r, w := io.Pipe()
	form := multipart.NewWriter(w)
	go func() {
		part, err := form.CreateFormFile("demo", name)
		if err == nil {
			_, err = io.Copy(part, content)
		}
		if closeErr := form.Close(); err == nil {
			err = closeErr
		}
		_ = w.CloseWithError(err)
	}()
	request := httptest.NewRequest(http.MethodPost, url, r)
	request.Header.Set("Content-Type", form.FormDataContentType())
	return request
}

func submitTestDemo(t *testing.T, h http.Handler, name string, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	r := demoRequest("http://127.0.0.1:8765/api/demos", name, bytes.NewReader(content))
	defer r.Body.Close()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func acceptedDemoID(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	if w.Code != http.StatusAccepted {
		t.Fatalf("upload status = %d: %s", w.Code, w.Body.String())
	}
	var response struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || response.ID == "" {
		t.Fatalf("missing upload job ID: %s (%v)", w.Body.String(), err)
	}
	return response.ID
}

func TestLocalViewerAssetsAndAccess(t *testing.T) {
	_, h := testViewer(t)
	for _, path := range []string{"/api/health", "/", "/app.js", "/maps/de_mirage.png", "/api/maps/de_mirage"} {
		t.Run(path, func(t *testing.T) {
			w := localRequest(h, http.MethodGet, path)
			if w.Code != http.StatusOK || w.Body.Len() == 0 {
				t.Fatalf("GET %s = %d, %d bytes", path, w.Code, w.Body.Len())
			}
		})
	}
	w := localRequest(h, http.MethodGet, "/api/maps/de_mirage")
	var radar struct {
		Radar string  `json:"radar"`
		Scale float64 `json:"scale"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &radar); err != nil || radar.Radar != "/maps/de_mirage.png" || radar.Scale <= 0 {
		t.Fatalf("invalid map metadata: %s (%v)", w.Body.String(), err)
	}
	if w := localRequest(h, http.MethodGet, "/api/maps/de_unknown"); w.Code != http.StatusNotFound {
		t.Fatalf("unknown map = %d, want 404", w.Code)
	}
	for _, tc := range []struct {
		name, host, origin, fetchSite string
		status                        int
	}{
		{"same origin", "127.0.0.1:8765", "http://127.0.0.1:8765", "same-origin", 200},
		{"foreign host", "attacker.example:8765", "", "", 403},
		{"foreign origin", "127.0.0.1:8765", "https://attacker.example", "", 403},
		{"different local port", "127.0.0.1:8765", "http://127.0.0.1:9999", "", 403},
		{"cross site", "127.0.0.1:8765", "", "cross-site", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8765/api/health", nil)
			r.Host = tc.host
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("Sec-Fetch-Site", tc.fetchSite)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status = %d, want %d: %s", w.Code, tc.status, w.Body.String())
			}
		})
	}
}

func TestUploadValidationReleasesResources(t *testing.T) {
	a, h := testViewer(t)
	for _, tc := range []struct{ name, body string }{
		{"match.zip", "PBDEMS2\x00"},
		{"match.dem", "notademo"},
		{"short.dem", "PBD"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := submitTestDemo(t, h, tc.name, []byte(tc.body))
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", w.Code, w.Body.String())
			}
		})
	}
	if len(a.slots) != 0 {
		t.Fatal("invalid uploads retained processing slots")
	}
	entries, err := os.ReadDir(a.root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("invalid uploads left temporary files: %v (%v)", entries, err)
	}
}

func waitForTestJob(t *testing.T, h http.Handler, id string) string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		w := localRequest(h, http.MethodGet, "/api/demos/"+id+"/status")
		var status struct {
			Status string `json:"status"`
			Error  string `json:"error"`
		}
		if w.Code != http.StatusOK {
			t.Fatalf("job status = %d: %s", w.Code, w.Body.String())
		}
		if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
			t.Fatal(err)
		}
		if status.Status == "ready" || status.Status == "error" {
			if status.Status == "error" && status.Error == "" {
				t.Fatal("failed job omitted its error message")
			}
			return status.Status
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("job did not finish within 10 seconds")
	return ""
}

func TestCorruptDemoDoesNotStopWorker(t *testing.T) {
	_, h := testViewer(t)
	// A valid CS2 signature with no remaining header must fail asynchronously.
	// Import twice to establish that failure leaves the worker usable.
	for attempt := 0; attempt < 2; attempt++ {
		id := acceptedDemoID(t, submitTestDemo(t, h, "broken.dem", []byte("PBDEMS2\x00")))
		if status := waitForTestJob(t, h, id); status != "error" {
			t.Fatalf("corrupt demo status = %q, want error", status)
		}
		if w := localRequest(h, http.MethodGet, "/api/demos/"+id); w.Code != http.StatusConflict {
			t.Fatalf("failed demo result = %d, want 409", w.Code)
		}
		if w := localRequest(h, http.MethodGet, "/api/health"); w.Code != http.StatusOK {
			t.Fatalf("health after parse error = %d", w.Code)
		}
	}
}

func TestDeleteCancelsAndRemovesJob(t *testing.T) {
	a, h := testViewer(t)
	id := acceptedDemoID(t, submitTestDemo(t, h, "cancel.dem", []byte("PBDEMS2\x00")))
	a.mu.Lock()
	j := a.jobs[id]
	a.mu.Unlock()
	if w := localRequest(h, http.MethodDelete, "/api/demos/"+id); w.Code != http.StatusNoContent {
		t.Fatalf("DELETE = %d, want 204", w.Code)
	}
	if j.ctx.Err() != context.Canceled {
		t.Fatalf("job context = %v, want cancellation", j.ctx.Err())
	}
	for _, path := range []string{"/api/demos/" + id, "/api/demos/" + id + "/status"} {
		if w := localRequest(h, http.MethodGet, path); w.Code != http.StatusNotFound {
			t.Fatalf("GET deleted job %s = %d, want 404", path, w.Code)
		}
	}
	if w := localRequest(h, http.MethodDelete, "/api/demos/"+id); w.Code != http.StatusNoContent {
		t.Fatalf("repeated DELETE = %d, want 204", w.Code)
	}
}

func TestRealDemoHTTPRoundTrip(t *testing.T) {
	path := os.Getenv("CS2_TEST_DEMO")
	if path == "" {
		t.Skip("set CS2_TEST_DEMO to a local CS2 match .dem for end-to-end parsing")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	_, h := testViewer(t)
	srv := httptest.NewServer(h)
	defer srv.Close()
	transport := &http.Transport{DisableCompression: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Minute}
	r := demoRequest(srv.URL+"/api/demos", filepath.Base(path), f)
	// NewRequest creates server requests; clear RequestURI before client use.
	r.RequestURI = ""
	res, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	var uploaded struct {
		ID string `json:"id"`
	}
	err = json.NewDecoder(res.Body).Decode(&uploaded)
	res.Body.Close()
	if err != nil || res.StatusCode != http.StatusAccepted || uploaded.ID == "" {
		t.Fatalf("upload = %d, ID %q (%v)", res.StatusCode, uploaded.ID, err)
	}
	deadline := time.Now().Add(5 * time.Minute)
	ready := false
	for time.Now().Before(deadline) {
		res, err = client.Get(srv.URL + "/api/demos/" + uploaded.ID + "/status")
		if err != nil {
			t.Fatal(err)
		}
		var status struct {
			Status string `json:"status"`
			Error  string `json:"error"`
		}
		err = json.NewDecoder(res.Body).Decode(&status)
		res.Body.Close()
		if err != nil || res.StatusCode != http.StatusOK {
			t.Fatalf("status = %d (%v)", res.StatusCode, err)
		}
		if status.Status == "error" {
			t.Fatalf("real demo parse failed: %s", status.Error)
		}
		if status.Status == "ready" {
			ready = true
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !ready {
		t.Fatal("real demo did not finish within 5 minutes")
	}
	var firstMap string
	var firstRounds int
	for _, encoding := range []string{"gzip", "identity"} {
		t.Run(encoding, func(t *testing.T) {
			r, err := http.NewRequest(http.MethodGet, srv.URL+"/api/demos/"+uploaded.ID, nil)
			if err != nil {
				t.Fatal(err)
			}
			r.Header.Set("Accept-Encoding", encoding)
			res, err := client.Do(r)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != http.StatusOK {
				t.Fatalf("result = %d", res.StatusCode)
			}
			var reader io.Reader = res.Body
			if encoding == "gzip" {
				if res.Header.Get("Content-Encoding") != "gzip" {
					t.Fatal("gzip result missing Content-Encoding")
				}
				gz, err := gzip.NewReader(reader)
				if err != nil {
					t.Fatal(err)
				}
				defer gz.Close()
				reader = gz
			} else if res.Header.Get("Content-Encoding") != "" {
				t.Fatal("identity result unexpectedly compressed")
			}
			var d struct {
				ID       string  `json:"id"`
				Map      string  `json:"map"`
				Duration float64 `json:"duration"`
				Rounds   []Round `json:"rounds"`
				Frames   []struct {
					T float64 `json:"t"`
				} `json:"frames"`
			}
			if err := json.NewDecoder(reader).Decode(&d); err != nil {
				t.Fatal(err)
			}
			if d.ID != uploaded.ID || strings.TrimSpace(d.Map) == "" || d.Duration <= 0 || len(d.Rounds) == 0 || len(d.Frames) < 2 {
				t.Fatalf("incomplete playback: ID=%q map=%q duration=%f rounds=%d frames=%d", d.ID, d.Map, d.Duration, len(d.Rounds), len(d.Frames))
			}
			for i := 1; i < len(d.Frames); i++ {
				if d.Frames[i].T < d.Frames[i-1].T {
					t.Fatalf("playback time moved backward at frame %d", i)
				}
			}
			if firstMap == "" {
				firstMap, firstRounds = d.Map, len(d.Rounds)
			} else if firstMap != d.Map || firstRounds != len(d.Rounds) {
				t.Fatal("gzip and identity results differ")
			}
			t.Logf("%s: %s, %d rounds, %d frames, %.1f seconds", encoding, d.Map, len(d.Rounds), len(d.Frames), d.Duration)
		})
	}
}
