package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func tinyModelPNG(t *testing.T) string {
	t.Helper()
	var out bytes.Buffer
	if err := png.Encode(&out, image.NewGray(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(out.Bytes())
}

func TestAIProviderTextAndImageOutputs(t *testing.T) {
	inline := tinyModelPNG(t)
	const remote = "https://images.example.test/game/ct.png?signature=x"
	markdown := "开局分析\n![防守图](<" + remote + "> \"第 2 回合\")\n结束"
	part := func(kind string, fields map[string]any) map[string]any {
		fields["type"] = kind
		return fields
	}
	for _, tc := range []struct {
		name       string
		message    map[string]any
		explicit   bool
		wantAnswer string
		wantImages []insightsImage
		warn       bool
	}{
		{"text only", map[string]any{"content": "观察到两回合"}, false, "观察到两回合", []insightsImage{}, false},
		{"explicit text fallback", map[string]any{"content": "观察到两回合"}, true, "观察到两回合", []insightsImage{}, true},
		{"image only", map[string]any{"content": nil, "images": []any{part("image_url", map[string]any{"image_url": map[string]any{"url": inline}})}}, true, "", []insightsImage{{inline, ""}}, false},
		{"multipart", map[string]any{"content": []any{
			part("text", map[string]any{"text": "图中标出首杀。"}),
			part("image_url", map[string]any{"image_url": map[string]any{"url": inline}, "alt": "首杀分布"}),
			part("text", map[string]any{"text": "共 8 回合。"}),
		}}, false, "图中标出首杀。\n共 8 回合。", []insightsImage{{inline, "首杀分布"}}, false},
		{"markdown", map[string]any{"content": markdown}, false, "开局分析\n\n结束", []insightsImage{{remote, "防守图"}}, false},
		{"inline markdown", map[string]any{"content": "![实际位图](" + inline + ")"}, false, "", []insightsImage{{inline, "实际位图"}}, false},
		{"invalid image with useful text", map[string]any{"content": "统计正确", "images": []any{map[string]any{"url": "file:///bad.svg"}}}, true, "统计正确", []insightsImage{}, true},
		{"raw base64", map[string]any{"images": []any{map[string]any{"b64_json": strings.TrimPrefix(inline, "data:image/png;base64,")}}}, false, "", []insightsImage{{inline, ""}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var in struct {
					Modalities []string `json:"modalities"`
				}
				if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
					t.Error(err)
				}
				if tc.explicit && !slices.Equal(in.Modalities, []string{"image", "text"}) || !tc.explicit && in.Modalities != nil {
					t.Errorf("unexpected modalities %v", in.Modalities)
				}
				json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": tc.message}}})
			}))
			defer provider.Close()
			_, h := testViewer(t)
			input := map[string]any{"demoIds": []string{"sample"}, "question": "复盘", "model": "fixture", "baseUrl": provider.URL}
			if tc.explicit {
				input["imageOutput"] = true
			}
			response := postInsights(t, h, input)
			var reply insightsAnswer
			if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &reply) != nil {
				t.Fatalf("invalid reply status %d: %s", response.Code, response.Body.String())
			}
			if reply.Answer != tc.wantAnswer || reply.Images == nil || !slices.Equal(reply.Images, tc.wantImages) || (reply.ImageWarning != "") != tc.warn {
				t.Fatalf("invalid reply %+v", reply)
			}
		})
	}
}

func TestModelImageValidationAndLimits(t *testing.T) {
	pngURL := tinyModelPNG(t)
	pngBytes, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(pngURL, "data:image/png;base64,"))
	for _, raw := range []string{
		"file:///d:/review.png", "javascript:alert(1)", "http://example.org/one",
		"https://name:secret@example.org/one.png", "https://127.0.0.1/private", "https://example.org/a.SVG?x=3",
		"data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte("<svg/>")),
		strings.Replace(pngURL, "image/png", "image/gif", 1),
		"data:image/png;base64," + base64.StdEncoding.EncodeToString(pngBytes[:35]),
		"data:image/png;base64," + strings.Repeat("A", base64.StdEncoding.EncodedLen(maxInsightsImageBytes)+1),
	} {
		if safeInsightsImage(raw) != "" {
			t.Fatal("accepted unsafe or corrupt image")
		}
	}
	var wide bytes.Buffer
	if err := png.Encode(&wide, image.NewGray(image.Rect(0, 0, 8193, 1))); err != nil {
		t.Fatal(err)
	}
	if safeInsightsImage("data:image/png;base64,"+base64.StdEncoding.EncodeToString(wide.Bytes())) != "" {
		t.Fatal("accepted unsupported dimensions")
	}
	reply, err := parseInsightsAnswer([]byte(`{"choices":[{"message":{"images":[{"url":"https://assets.example/1"},{"url":"https://assets.example/1"},{"url":"https://assets.example/2"},{"url":"https://assets.example/3"},{"url":"https://assets.example/4"},{"url":"https://assets.example/5"}]}}]}`), true)
	if err != nil || len(reply.Images) != maxInsightsImages || reply.ImageWarning == "" || reply.Images[1].URL != "https://assets.example/2" {
		t.Fatalf("invalid deduplication or limit %+v %v", reply, err)
	}
	if _, err := parseInsightsAnswer([]byte(`{"choices":[{"message":{"content":"![bad](javascript:bad)"}}]}`), false); err == nil {
		t.Fatal("unsupported image-only response reported success")
	}
}
