package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func postInsights(t *testing.T, h http.Handler, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8767/api/insights/ask", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	reply := httptest.NewRecorder()
	h.ServeHTTP(reply, req)
	return reply
}

func TestAIQuestionUsesSelectedEvidenceAndOwnCredentials(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "POST" || r.URL.Path != "/v1/chat/completions" {
			t.Error("unexpected provider request", r.Method, r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		var prompt struct{ Messages []struct{ Role string } }
		if json.Unmarshal(body, &prompt) != nil || len(prompt.Messages) != 2 ||
			prompt.Messages[0].Role != "system" || prompt.Messages[1].Role != "user" {
			t.Error("expected a system prompt followed by one user turn")
		}
		if !bytes.Contains(body, []byte("sample")) || !bytes.Contains(body, []byte("看看这三回合")) || !bytes.Contains(body, []byte("local-test")) {
			t.Error("missing evidence, model or question")
		}
		if r.Header.Get("Authorization") != "Bearer page-test-secret" || bytes.Contains(body, []byte("secret")) {
			t.Error("incorrect key handling")
		}
		io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"示例比赛的分析"}}]}`)
	}))
	defer provider.Close()
	t.Setenv("CS2_AI_API_KEY", "server-test-secret")
	t.Setenv("CS2_AI_MODEL", "configured-model")
	t.Setenv("CS2_AI_BASE_URL", "https://provider.invalid/v1")
	_, h := testViewer(t)
	input := map[string]any{"demoIds": []string{"sample"}, "baseUrl": provider.URL + "/v1/", "model": "local-test", "apiKey": "page-test-secret", "question": "看看这三回合"}
	reply := postInsights(t, h, input)
	if reply.Code != 200 || !strings.Contains(reply.Body.String(), "示例比赛的分析") || strings.Contains(reply.Body.String(), "secret") {
		t.Fatalf("status %d %s", reply.Code, reply.Body.String())
	}
	config := localRequest(h, "GET", "/api/insights/config").Body.String()
	if strings.Contains(config, "secret") || !strings.Contains(config, "configured-model") {
		t.Fatal("incorrect config metadata")
	}
	delete(input, "model")
	if w := postInsights(t, h, input); w.Code != 400 {
		t.Fatalf("partial override: %d", w.Code)
	}
	input["model"] = "local-test"
	input["demoIds"] = []string{"no-such-demo"}
	if w := postInsights(t, h, input); w.Code == 200 || calls.Load() != 1 {
		t.Fatalf("invalid scope reached provider: %d", w.Code)
	}
}

func TestAIProviderDestinationIsolation(t *testing.T) {
	var forwarded atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded.Store(true)
	}))
	defer target.Close()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("custom host inherited environment key")
		}
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer provider.Close()
	t.Setenv("CS2_AI_API_KEY", "server-only-secret")
	_, h := testViewer(t)
	input := map[string]any{"demoIds": []string{"sample"}, "baseUrl": provider.URL, "model": "custom", "question": "复盘"}
	if w := postInsights(t, h, input); w.Code != 502 || forwarded.Load() {
		t.Fatalf("redirect handling %d", w.Code)
	}
	for _, bad := range []string{"http://192.0.2.1/v1", "https://user:secret@example.org", "https://example.org/v1?api_key=secret", "file:///anything"} {
		input["baseUrl"] = bad
		if w := postInsights(t, h, input); w.Code != 400 || strings.Contains(w.Body.String(), "secret") {
			t.Fatalf("destination validation: %d", w.Code)
		}
	}
}
