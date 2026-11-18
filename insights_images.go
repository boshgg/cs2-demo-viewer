package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"net"
	"net/url"
	"path"
	"regexp"
	"strings"
	"unicode"
)

const (
	maxInsightsReplyBytes = 32 << 20 // Includes JSON and base64 overhead.
	maxInsightsImageBytes = 6 << 20
	maxInsightsImages     = 4
)

type insightsImage struct {
	URL string `json:"url"`
	Alt string `json:"alt"`
}

type insightsAnswer struct {
	Answer       string          `json:"answer"`
	Images       []insightsImage `json:"images"`
	ImageWarning string          `json:"imageWarning,omitempty"`
}

// For a Chat Completions content part or an entry of message.images.
type insightsPart struct {
	Type     string          `json:"type"`
	Text     string          `json:"text"`
	ImageURL json.RawMessage `json:"image_url"`
	URL      string          `json:"url"`
	Alt      string          `json:"alt"`
	Base64   string          `json:"b64_json"`
}

func (p insightsPart) image() insightsImage {
	img := insightsImage{p.URL, p.Alt}
	switch {
	case len(p.ImageURL) > 0 && p.ImageURL[0] == '{':
		_ = json.Unmarshal(p.ImageURL, &img)
	case len(p.ImageURL) > 0:
		_ = json.Unmarshal(p.ImageURL, &img.URL)
	}
	return img
}

func normalizedInlineImage(declared, encoded string) string {
	if len(encoded) == 0 || len(encoded) > base64.StdEncoding.EncodedLen(maxInsightsImageBytes) {
		return ""
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(data) > maxInsightsImageBytes {
		return ""
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 8192 || config.Height > 8192 || int64(config.Width)*int64(config.Height) > 16<<20 {
		return ""
	}
	mime := "image/" + format
	if (format != "png" && format != "jpeg" && format != "gif") || (declared != "" && declared != mime) {
		return ""
	}
	// Decode only after checking the dimensions. A valid header alone does
	// not guarantee that a truncated response contains a displayable bitmap.
	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		return ""
	}
	return "data:" + mime + ";base64," + encoded
}

func safeInsightsImage(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "data:") {
		header, encoded, found := strings.Cut(raw, ",")
		if !found || !strings.HasSuffix(header, ";base64") {
			return ""
		}
		mime := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
		if mime != "image/png" && mime != "image/jpeg" && mime != "image/gif" {
			return ""
		}
		return normalizedInlineImage(mime, encoded)
	}
	if len(raw) > 8192 || strings.Contains(raw, "\\") || strings.IndexFunc(raw, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return ""
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return ""
	}
	if ip := net.ParseIP(host); ip != nil && (!ip.IsGlobalUnicast() || ip.IsPrivate()) {
		return ""
	}
	switch strings.ToLower(path.Ext(u.Path)) {
	case ".svg", ".svgz", ".html", ".htm", ".xhtml", ".js":
		return ""
	}
	return raw
}

// Keep prose as plain text and lift inline Markdown images into the gallery.
// Handles normal paths, one parenthesized path component, angle-bracket URLs,
// and optional quoted titles.
var insightsMarkdownImage = regexp.MustCompile(`!\[([^\]\r\n]{0,512})\]\([ \t]*(?:<([^<>\r\n]+)>|((?:[^\s()<>]|\([^\s()<>]*\))+))(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'))?[ \t]*\)`)

func parseInsightsAnswer(data []byte, imageOutput bool) (insightsAnswer, error) {
	var out struct {
		Choices []struct {
			Message struct {
				Content json.RawMessage   `json:"content"`
				Images  []json.RawMessage `json:"images"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(data, &out) != nil || len(out.Choices) == 0 {
		return insightsAnswer{}, errors.New("无法读取模型回答，请确认服务兼容 Chat Completions")
	}
	answer := insightsAnswer{Images: []insightsImage{}}
	addImage := func(img insightsImage, rawBase64 string) {
		for _, old := range answer.Images {
			if img.URL == old.URL {
				return
			}
		}
		if len(answer.Images) >= maxInsightsImages {
			answer.ImageWarning = "最多显示 4 张模型图片，超过数量的图片已略过。"
			return
		}
		if img.URL == "" && rawBase64 != "" {
			img.URL = normalizedInlineImage("", rawBase64)
		} else {
			img.URL = safeInsightsImage(img.URL)
		}
		if img.URL == "" {
			answer.ImageWarning = "有图片因格式、地址、尺寸或文件大小限制未能显示。"
			return
		}
		alt := []rune(strings.TrimSpace(img.Alt))
		if len(alt) > 256 {
			alt = alt[:256]
		}
		img.Alt = string(alt)
		answer.Images = append(answer.Images, img)
	}
	message := out.Choices[0].Message
	var texts []string
	if len(message.Content) > 0 && message.Content[0] == '[' {
		var parts []json.RawMessage
		if json.Unmarshal(message.Content, &parts) == nil {
			for _, raw := range parts {
				var part insightsPart
				if json.Unmarshal(raw, &part) != nil {
					continue
				}
				switch part.Type {
				case "text", "output_text":
					texts = append(texts, part.Text)
				case "image_url", "image", "output_image":
					addImage(part.image(), part.Base64)
				}
			}
		}
	} else {
		var text string
		if json.Unmarshal(message.Content, &text) == nil {
			texts = append(texts, text)
		}
	}
	for _, raw := range message.Images {
		var part insightsPart
		if len(raw) > 0 && raw[0] == '"' {
			_ = json.Unmarshal(raw, &part.URL)
		} else if json.Unmarshal(raw, &part) != nil {
			answer.ImageWarning = "有图片的返回格式未能识别。"
			continue
		}
		addImage(part.image(), part.Base64)
	}
	text := strings.Join(texts, "\n")
	var prose strings.Builder
	last := 0
	for {
		rest := text[last:]
		m := insightsMarkdownImage.FindStringSubmatchIndex(rest)
		if m == nil {
			break
		}
		prose.WriteString(rest[:m[0]])
		from, to := m[4], m[5]
		if from < 0 {
			from, to = m[6], m[7]
		}
		addImage(insightsImage{rest[from:to], rest[m[2]:m[3]]}, "")
		last += m[1]
	}
	prose.WriteString(text[last:])
	answer.Answer = strings.TrimSpace(prose.String())
	if len(answer.Answer) > 1<<20 {
		return insightsAnswer{}, errors.New("模型回答正文过长，请缩小问题或请求更简短的回答")
	}
	if answer.Answer == "" && len(answer.Images) == 0 {
		return insightsAnswer{}, errors.New("模型未返回可显示的文字或图片。支持 HTTPS 图片地址，以及每张最多 6 MiB 的 PNG、JPEG 或 GIF 内嵌图片")
	}
	if imageOutput && len(answer.Images) == 0 && answer.ImageWarning == "" {
		answer.ImageWarning = "此模型本次仅返回文字，请检查服务是否支持图片输出。"
	}
	return answer, nil
}
