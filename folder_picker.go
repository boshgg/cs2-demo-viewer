package main

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
)

// A native dialog belongs to the desktop, shared by all viewer tabs.
var folderPickerGate = make(chan struct{}, 1)

func (a *app) pickLibraryDirectory(w http.ResponseWriter, r *http.Request) {
	mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaType != "application/json" {
		apiError(w, http.StatusUnsupportedMediaType, "请选择 JSON 请求格式")
		return
	}
	var body map[string]json.RawMessage
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	if err := decoder.Decode(&body); err != nil || body == nil || len(body) != 0 || decoder.Decode(new(any)) != io.EOF {
		apiError(w, http.StatusBadRequest, "文件夹选择器仅接受空对象")
		return
	}
	select {
	case folderPickerGate <- struct{}{}:
		defer func() { <-folderPickerGate }()
	default:
		apiError(w, http.StatusConflict, "已有文件夹选择窗口打开")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stop := context.AfterFunc(a.ctx, cancel)
	defer stop()
	a.mu.Lock()
	initial := a.demoDir
	a.mu.Unlock()
	directory, err := browseDemoFolder(ctx, initial)
	if err != nil {
		apiError(w, http.StatusServiceUnavailable, "无法打开系统文件夹选择器，可直接输入或粘贴完整路径")
		return
	}
	jsonResponse(w, http.StatusOK, map[string]string{"directory": directory})
}
