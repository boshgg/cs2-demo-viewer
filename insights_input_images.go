package main

import (
	"errors"
	"fmt"
	"strings"
)

const (
	maxInsightsInputImageBytes = 12 << 20 // Combined decoded attachments.
	maxInsightsAskBytes        = 4*(maxInsightsInputImageBytes/3) + (64 << 10)
)

// Attachments must be actual inline bitmaps so neither the viewer nor the
// model service needs to fetch a URL supplied by the browser.
func validateInsightsInputImages(images []string) error {
	if len(images) > maxInsightsImages {
		return fmt.Errorf("每次最多发送 %d 张图片", maxInsightsImages)
	}
	total := 0
	for i, raw := range images {
		header, encoded, ok := strings.Cut(raw, ",")
		if !ok || (header != "data:image/png;base64" && header != "data:image/jpeg;base64" && header != "data:image/gif;base64") {
			return fmt.Errorf("第 %d 张图片需要使用 PNG、JPEG 或 GIF 文件", i+1)
		}
		declared := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
		mime, size := inspectInlineImage(declared, encoded)
		if mime == "" {
			return fmt.Errorf("第 %d 张图片无法读取，请使用有效的 PNG、JPEG 或 GIF，单张不超过 6 MiB、每边不超过 8192 像素，总像素不超过 16777216", i+1)
		}
		total += size
		if total > maxInsightsInputImageBytes {
			return errors.New("附件图片合计最多 12 MiB，请减少图片或压缩后重试")
		}
	}
	return nil
}

// Keep the ordinary string content for text-only Chat Completions models.
func insightsUserContent(text string, images []string) any {
	if len(images) == 0 {
		return text
	}
	type imageURL struct {
		URL string `json:"url"`
	}
	type part struct {
		Type     string    `json:"type"`
		Text     string    `json:"text,omitempty"`
		ImageURL *imageURL `json:"image_url,omitempty"`
	}
	parts := []part{{Type: "text", Text: text}}
	for _, url := range images {
		parts = append(parts, part{Type: "image_url", ImageURL: &imageURL{URL: url}})
	}
	return parts
}
