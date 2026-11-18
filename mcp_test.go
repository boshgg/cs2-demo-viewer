package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestViewerMCPStdioLifecycle(t *testing.T) {
	bridge, err := newViewerMCP("http://localhost:8767")
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.client.CloseIdleConnections()
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
		`broken`,
		`{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"integration-test","version":"1"},"capabilities":{}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"delete_library"}}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_demo_status","arguments":{"demoId":"../api/anything"}}}`,
		`{"jsonrpc":"2.0","id":6,"method":"ping"}`,
	}, "\n")
	var out bytes.Buffer
	if err = bridge.serve(strings.NewReader(input), &out); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 8 {
		t.Fatalf("expected one response per request and none to notifications, got %d:\n%s", len(lines), out.String())
	}
	type result struct {
		ID      json.RawMessage `json:"id"`
		Version string          `json:"jsonrpc"`
		Error   *mcpError       `json:"error"`
		Result  struct {
			ProtocolVersion string        `json:"protocolVersion"`
			Tools           []mcpToolSpec `json:"tools"`
			IsError         bool          `json:"isError"`
			Content         []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	results := make([]result, len(lines))
	for i, line := range lines {
		if err = json.Unmarshal([]byte(line), &results[i]); err != nil || results[i].Version != "2.0" {
			t.Fatalf("bad wire response: %q", line)
		}
	}
	for n, code := range map[int]int{0: -32002, 1: -32700, 3: -32002, 5: -32602} {
		if e := results[n].Error; e == nil || e.Code != code {
			t.Fatalf("response %d error = %+v", n, e)
		}
	}
	if string(results[2].ID) != `"init"` || results[2].Result.ProtocolVersion != "2025-06-18" {
		t.Fatal("initialization did not preserve request ID and supported protocol version")
	}
	specs := results[4].Result.Tools
	if len(specs) != 6 {
		t.Fatalf("tools/list returned %d tools", len(specs))
	}
	if !results[6].Result.IsError || len(results[6].Result.Content) == 0 || results[6].Result.Content[0].Text == "" {
		t.Fatalf("invalid tool arguments were not reported as tool error: %s", lines[6])
	}
}

func TestViewerMCPReadsAndControlsLibrary(t *testing.T) {
	assets, err := fs.Sub(webFiles, "web")
	if err != nil {
		t.Fatal(err)
	}
	app, err := openLibrary(t.TempDir(), t.TempDir(), assets)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	const id = "111111111111111111111111"
	const other = "222222222222222222222222"
	statisticsFixture(t, app, id, id, "Match A")
	statisticsFixture(t, app, other, other, "Match B")
	srv := httptest.NewServer(app.handler())
	defer srv.Close()
	bridge, err := newViewerMCP(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.client.CloseIdleConnections()
	call := func(name, args string) mcpObject {
		t.Helper()
		value, err := bridge.callTool(context.Background(), name, json.RawMessage(args))
		if err != nil {
			t.Fatal(err)
		}
		b, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		var out mcpObject
		if err = json.Unmarshal(b, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	page := call("list_demos", `{"query":"match","offset":1,"limit":1}`)
	demos := page["demos"].([]any)
	if len(demos) != 1 || demos[0].(map[string]any)["id"] != other || page["hasMore"] != false || page["total"] != 2.0 {
		t.Fatal(page)
	}
	status := call("get_demo_status", `{"demoId":"`+id+`"}`)
	if status["id"] != id || status["analysis"] != false {
		t.Fatal(status)
	}
	summary := call("get_match_statistics", `{"demoId":"`+id+`"}`)
	if summary["demoId"] != id || summary["revision"] != id || len(summary["players"].([]any)) == 0 {
		t.Fatal("missing statistics evidence", summary)
	}
	round := call("get_match_statistics", `{"demoId":"`+id+`","round":1}`)
	if round["round"].(map[string]any)["number"] != 1.0 || len(round["kills"].([]any)) == 0 {
		t.Fatal("missing round evidence", round)
	}
	parsed := call("parse_demo", `{"demoId":"`+id+`","mode":"analysis"}`)
	if parsed["id"] != id || parsed["cached"] != true {
		t.Fatal(parsed)
	}
	status = call("get_demo_status", `{"demoId":"`+id+`"}`)
	if status["analysis"] != true {
		t.Fatal("analysis membership unchanged after MCP command")
	}
	scan := call("refresh_library", "{}")
	if scan["scanning"] != true || scan["directory"] != nil {
		t.Fatal(scan)
	}
}

func TestViewerMCPTargetAndArguments(t *testing.T) {
	for _, bad := range []string{"http://somewhere.invalid:8765", "https://127.0.0.1:8765", "http://127.0.0.1:8765/api", "http://127.0.0.1:8765?x=1", "http://x@127.0.0.1:8765", "http://127.0.0.1:0"} {
		if _, err := newViewerMCP(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	for _, args := range []string{`{"demoIds":["sample","000000000000000000000001"]}`, `{"demoIds":["sample"],"playerId":"p","team":"t"}`, `{"demoIds":[]}`, `{"demoIds":["sample"],"url":"http://somewhere.invalid"}`} {
		var b viewerMCP
		if _, err := b.callTool(context.Background(), "get_analysis_evidence", json.RawMessage(args)); err == nil {
			t.Fatalf("accepted %s", args)
		}
	}
	var redirects atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirects.Add(1) }))
	defer target.Close()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, 200, viewerHealth{"cs2-local-viewer", appVersion})
	})
	mux.HandleFunc("POST /api/insights/evidence", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	})
	local := httptest.NewServer(mux)
	defer local.Close()
	bridge, err := newViewerMCP(local.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.client.CloseIdleConnections()
	_, err = bridge.callTool(context.Background(), "get_analysis_evidence", json.RawMessage(`{"demoIds":["sample"]}`))
	if err == nil || !strings.Contains(err.Error(), "307") || redirects.Load() != 0 {
		t.Fatal("redirected evidence query", err, redirects.Load())
	}
}
