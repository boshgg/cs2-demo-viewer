package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/gif"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
)

func TestInsightsSendsTextOrOrderedImageParts(t *testing.T) {
	first := tinyModelPNG(t)
	var buf bytes.Buffer
	err := jpeg.Encode(&buf, image.NewGray(image.Rect(0, 0, 3, 2)), nil)
	if err != nil {
		t.Fatal(err)
	}
	jpegImage := "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
	buf.Reset()
	if err := gif.Encode(&buf, image.NewGray(image.Rect(0, 0, 3, 2)), nil); err != nil {
		t.Fatal(err)
	}
	gifImage := "data:image/gif;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
	for _, tc := range []struct {
		name, question, expected string
		images                   []string
		generate                 bool
	}{
		{"ordinary question", "只看首杀", "只看首杀", nil, false},
		{"ordered screenshots", "比较两张图", "比较两张图", []string{first, jpegImage}, false},
		{"image only", "", "分析我附上的图片", []string{gifImage}, false},
		{"image input and output", "在图上标出站位", "在图上标出站位", []string{first}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var called atomic.Int32
			p := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called.Add(1)
				var req struct {
					Messages []struct {
						Role    string
						Content json.RawMessage
					}
					Modalities []string
				}
				if json.NewDecoder(r.Body).Decode(&req) != nil || len(req.Messages) != 2 || req.Messages[1].Role != "user" {
					t.Error("invalid chat structure")
					return
				}
				if tc.generate != slices.Equal(req.Modalities, []string{"image", "text"}) || (!tc.generate && len(req.Modalities) != 0) {
					t.Errorf("unexpected output modalities %v", req.Modalities)
				}
				var text string
				if len(tc.images) == 0 {
					if json.Unmarshal(req.Messages[1].Content, &text) != nil {
						t.Error("ordinary request needs string content")
					}
				} else {
					var parts []struct {
						Type, Text string
						ImageURL   struct{ URL string } `json:"image_url"`
					}
					if json.Unmarshal(req.Messages[1].Content, &parts) != nil || len(parts) != len(tc.images)+1 || parts[0].Type != "text" {
						t.Error("unexpected multimodal parts")
						return
					}
					text = parts[0].Text
					for i, raw := range tc.images {
						if parts[i+1].Type != "image_url" || parts[i+1].ImageURL.URL != raw {
							t.Errorf("wrong image part %d", i)
						}
					}
				}
				if !strings.Contains(text, tc.expected) || !strings.Contains(text, "sample") || !strings.Contains(text, "当前交火图层") || strings.Contains(text, "base64,") {
					t.Error("missing question, evidence or chart context, or image encoded as text")
				}
				io.WriteString(w, `{"choices":[{"message":{"content":"review complete"}}]}`)
			}))
			defer p.Close()
			_, h := testViewer(t)
			out := postInsights(t, h, map[string]any{"demoIds": []string{"sample"}, "baseUrl": p.URL, "model": "vision-test", "question": tc.question, "inputImages": tc.images, "chartContext": "当前交火图层", "imageOutput": tc.generate})
			if out.Code != 200 || called.Load() != 1 || !strings.Contains(out.Body.String(), "review complete") || strings.Contains(out.Body.String(), "base64,") {
				t.Errorf("unexpected review status %d, provider calls %d", out.Code, called.Load())
			}
		})
	}
}

func TestInsightsInputImageValidationAndLimits(t *testing.T) {
	png := tinyModelPNG(t)
	for _, images := range [][]string{
		{"https://example.invalid/image.png"},
		{"data:image/svg+xml;base64,PHN2Zy8+"},
		{strings.Replace(png, "image/png", "image/jpeg", 1)},
		{"data:image/png;base64,invalid!"},
		{png[:len(png)-16]},
		{png, png, png, png, png},
	} {
		if err := validateInsightsInputImages(images); err == nil {
			t.Fatal("invalid image accepted")
		}
	}
	// Ancillary bytes still count toward the file size and combined budget.
	header, encoded, _ := strings.Cut(png, ",")
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	padded := make([]byte, maxInsightsImageBytes)
	copy(padded, data)
	full := header + "," + base64.StdEncoding.EncodeToString(padded)
	if err := validateInsightsInputImages([]string{full, full}); err != nil {
		t.Fatalf("valid request at 12 MiB: %v", err)
	}
	if err := validateInsightsInputImages([]string{full, full, png}); err == nil || !strings.Contains(err.Error(), "12 MiB") {
		t.Fatal("combined image limit not enforced")
	}
	if err := validateInsightsInputImages([]string{full + "AAAA"}); err == nil {
		t.Fatal("single image limit not enforced")
	}
}

func TestInsightsUnsupportedImageModelAndLargeRequest(t *testing.T) {
	var called atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called.Add(1)
		http.Error(w, "private provider diagnostic", http.StatusBadRequest)
	}))
	defer provider.Close()
	_, h := testViewer(t)
	input := map[string]any{"demoIds": []string{"sample"}, "baseUrl": provider.URL, "model": "text-only", "question": "看图", "inputImages": []string{tinyModelPNG(t)}}
	out := postInsights(t, h, input)
	if out.Code != 502 || !strings.Contains(out.Body.String(), "支持图片输入") || strings.Contains(out.Body.String(), "private provider") || called.Load() != 1 {
		t.Fatal("unsupported model must stop with a helpful error")
	}
	input["inputImages"] = []string{"https://example.invalid/remote.jpg"}
	if w := postInsights(t, h, input); w.Code != 400 || called.Load() != 1 {
		t.Fatal("unsupported attachment reached provider")
	}
	input["inputImages"] = []string{strings.Repeat("A", maxInsightsAskBytes+1)}
	if w := postInsights(t, h, input); w.Code != 413 || called.Load() != 1 {
		t.Fatal("oversized body reached provider")
	}
	delete(input, "inputImages")
	input["baseUrl"] = provider.URL + "/" + strings.Repeat("z", 64<<10)
	if w := postInsights(t, h, input); w.Code != 400 || called.Load() != 1 {
		t.Fatal("oversized connection details reached provider")
	}
}
