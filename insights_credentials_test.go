package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

func isolateInsightsCredentialStore(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("AppData", home)
	t.Setenv("XDG_CONFIG_HOME", home)
	if runtime.GOOS == "darwin" {
		t.Setenv("HOME", home)
	}
}

func credentialPost(t *testing.T, h http.Handler, port, path string, input map[string]any, modify func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	origin := "http://127.0.0.1:" + port
	r := httptest.NewRequest("POST", origin+path, bytes.NewReader(data))
	r.RemoteAddr = "127.0.0.1:12345"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", origin)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	if modify != nil {
		modify(r)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestInsightsCredentialAcrossViewerRestartsAndPortChanges(t *testing.T) {
	isolateInsightsCredentialStore(t)
	const secret = "unit-test-fake-key"
	var calls atomic.Int32
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer "+secret {
			t.Error("wrong provider destination or credential")
		}
		body, _ := io.ReadAll(r.Body)
		if bytes.Contains(body, []byte(secret)) {
			t.Error("key in model payload")
		}
		io.WriteString(w, `{"choices":[{"message":{"content":"ok"}}]}`)
	}))
	defer mock.Close()
	_, first := testViewer(t)
	creds := map[string]any{"provider": "custom", "baseUrl": mock.URL + "/v1/", "action": "save", "apiKey": secret}
	check := func(h http.Handler, port string, want bool) {
		t.Helper()
		w := credentialPost(t, h, port, "/api/insights/credential", creds, nil)
		var got struct {
			Saved bool `json:"saved"`
		}
		if w.Code != 200 || strings.Contains(w.Body.String(), secret) || json.Unmarshal(w.Body.Bytes(), &got) != nil || got.Saved != want {
			t.Errorf("unexpected credential response %d for %s", w.Code, creds["action"])
		}
	}
	check(first, "8765", true)
	dir, _ := insightsCredentialDirectory()
	files, err := filepath.Glob(filepath.Join(dir, "*.key"))
	if err != nil || len(files) != 1 {
		t.Fatal("expected one stored credential")
	}
	stored, err := os.ReadFile(files[0])
	if err != nil || len(stored) == 0 || (runtime.GOOS == "windows" && bytes.Contains(stored, []byte(secret))) {
		t.Fatal("unexpected on-disk credential protection")
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(files[0])
		if err != nil || info.Mode().Perm()&0077 != 0 {
			t.Fatal("credential is accessible to other users")
		}
	}
	delete(creds, "apiKey")
	creds["action"] = "status"
	creds["baseUrl"] = mock.URL + "/v1/chat/completions"
	_, second := testViewer(t)
	check(second, "8769", true)
	ask := map[string]any{"demoIds": []string{"sample"}, "question": "复盘", "model": "mock", "provider": "custom", "baseUrl": mock.URL + "/v1", "useSavedKey": true}
	w := credentialPost(t, second, "8769", "/api/insights/ask", ask, nil)
	if w.Code != 200 || calls.Load() != 1 || strings.Contains(w.Body.String(), secret) {
		t.Fatal("saved key not used as expected", w.Code)
	}
	w = credentialPost(t, second, "8769", "/api/insights/ask", ask, func(r *http.Request) {
		r.Header.Del("Origin")
	})
	if w.Code != 403 || calls.Load() != 1 {
		t.Fatal("saved key accepted outside the local page")
	}
	ask["baseUrl"] = mock.URL + "/another"
	w = credentialPost(t, second, "8769", "/api/insights/ask", ask, nil)
	if w.Code != 400 || calls.Load() != 1 {
		t.Fatal("key used with different endpoint path")
	}
	creds["action"] = "delete"
	check(second, "8769", false)
	creds["action"] = "status"
	check(first, "8765", false)
}

func TestInsightsCredentialReplacementAndRedirect(t *testing.T) {
	isolateInsightsCredentialStore(t)
	var reachesTarget atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reachesTarget.Store(true)
	}))
	defer target.Close()
	var reachesProvider atomic.Bool
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reachesProvider.Store(true)
		if r.Header.Get("Authorization") != "Bearer new-fake-token" {
			t.Error("provider did not receive the replacement credential")
		}
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer mock.Close()
	_, h := testViewer(t)
	creds := map[string]any{"provider": "custom", "action": "save", "baseUrl": mock.URL}
	for _, key := range []string{"old-fake-token", "new-fake-token"} {
		creds["apiKey"] = key
		if w := credentialPost(t, h, "8767", "/api/insights/credential", creds, nil); w.Code != 200 {
			t.Fatal("could not write credential", w.Code)
		}
	}
	req := map[string]any{"provider": "custom", "baseUrl": mock.URL, "model": "mock", "useSavedKey": true, "question": "复盘", "demoIds": []string{"sample"}}
	w := credentialPost(t, h, "8767", "/api/insights/ask", req, nil)
	if w.Code != 502 || !reachesProvider.Load() || reachesTarget.Load() {
		t.Fatal("provider redirect did not stop at original authenticated endpoint", w.Code)
	}
}

func TestInsightsCredentialOriginAndProviderIsolation(t *testing.T) {
	isolateInsightsCredentialStore(t)
	_, h := testViewer(t)
	const path = "/api/insights/credential"
	const preset = "https://API.DEEPSEEK.COM:443/"
	input := map[string]any{"provider": "deepseek", "baseUrl": preset, "action": "save", "apiKey": "fake-secret"}
	for _, modify := range []func(*http.Request){
		func(r *http.Request) { r.Header.Del("Origin") },
		func(r *http.Request) { r.Header.Set("Origin", "http://127.0.0.1:8812") },
		func(r *http.Request) { r.RemoteAddr = "192.0.2.1:3100" },
		func(r *http.Request) { r.Host = "app.example:8767"; r.Header.Set("Origin", "http://app.example:8767") },
		func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") },
	} {
		if w := credentialPost(t, h, "8767", path, input, modify); w.Code != 403 {
			t.Error("unexpected origin authorization", w.Code)
		}
	}
	w := credentialPost(t, h, "8767", path, input, nil)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	input["action"] = "status"
	delete(input, "apiKey")
	input["baseUrl"] = "https://api.deepseek.com/chat/completions/"
	w = credentialPost(t, h, "8767", path, input, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"saved":true`) {
		t.Fatal("normalized destination mismatch")
	}
	input["provider"] = "custom"
	w = credentialPost(t, h, "8767", path, input, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"saved":false`) {
		t.Fatal("preset leaked to custom profile")
	}
	input["provider"] = "deepseek"
	input["baseUrl"] = "https://example.invalid"
	if w := credentialPost(t, h, "8767", path, input, nil); w.Code != 400 {
		t.Fatal("unbound official provider", w.Code)
	}
}
