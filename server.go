package main

import (
	"compress/gzip"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const maxUploadBytes int64 = 2 << 30

type job struct {
	mu                   sync.Mutex
	ID                   string  `json:"id"`
	Status               string  `json:"status"`
	Progress             float64 `json:"progress"`
	Message              string  `json:"message,omitempty"`
	Error                string  `json:"error,omitempty"`
	name, source, result string
	created              time.Time
	ctx                  context.Context
	cancel               context.CancelFunc
}

type app struct {
	root   string
	assets fs.FS
	mu     sync.Mutex
	jobs   map[string]*job
	queue  chan *job
	slots  chan struct{}
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func newApp(root string, assets fs.FS) *app {
	ctx, cancel := context.WithCancel(context.Background())
	a := &app{root: root, assets: assets, jobs: map[string]*job{}, queue: make(chan *job, 3), slots: make(chan struct{}, 3), ctx: ctx, cancel: cancel}
	a.wg.Add(1)
	go a.worker()
	return a
}

func (a *app) close() {
	a.cancel()
	a.wg.Wait()
	// Only delete generated files in this instance's private temp directory.
	entries, _ := os.ReadDir(a.root)
	for _, e := range entries {
		if !e.IsDir() {
			_ = os.Remove(filepath.Join(a.root, e.Name()))
		}
	}
	_ = os.Remove(a.root)
}

func jsonResponse(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func apiError(w http.ResponseWriter, status int, message string) {
	jsonResponse(w, status, map[string]string{"error": message})
}

func (a *app) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, 200, map[string]any{"app": "cs2-local-viewer", "version": "3.1.0", "parser": "demoinfocs-golang v5.2.0"})
	})
	mux.HandleFunc("POST /api/demos", a.upload)
	mux.HandleFunc("GET /api/demos/{id}/status", a.status)
	mux.HandleFunc("GET /api/demos/{id}", a.result)
	mux.HandleFunc("DELETE /api/demos/{id}", a.remove)
	mux.HandleFunc("GET /api/maps/{map}", a.mapInfo)
	mux.HandleFunc("GET /api/sample", func(w http.ResponseWriter, r *http.Request) { jsonResponse(w, 200, sampleDemo()) })
	files := http.FileServer(http.FS(a.assets))
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		info, err := fs.Stat(a.assets, path)
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
		// Accept only direct loopback requests, including when a hostile DNS name resolves here.
		host := r.Host
		if h := strings.LastIndex(host, ":"); h >= 0 {
			host = host[:h]
		}
		if host != "127.0.0.1" && host != "localhost" && host != "[::1]" {
			apiError(w, 403, "此服务仅接受本机访问")
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || u.Host != r.Host || u.Scheme != "http" {
				apiError(w, 403, "不允许来自其他网站的请求")
				return
			}
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			apiError(w, 403, "不允许跨站请求")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (a *app) upload(w http.ResponseWriter, r *http.Request) {
	select {
	case a.slots <- struct{}{}:
	default:
		apiError(w, 429, "已有文件正在处理，请稍后再导入")
		return
	}
	queued := false
	defer func() {
		if !queued {
			<-a.slots
		}
	}()
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes+(256<<10))
	reader, err := r.MultipartReader()
	if err != nil {
		apiError(w, 400, "请选择 .dem 文件")
		return
	}
	var source, name string
	defer func() {
		if !queued && source != "" {
			_ = os.Remove(source)
		}
	}()
	for {
		part, e := reader.NextPart()
		if e == io.EOF {
			break
		}
		if e != nil {
			apiError(w, 400, "文件上传失败或超过 2 GB 限制")
			return
		}
		if part.FormName() != "demo" || part.FileName() == "" {
			_ = part.Close()
			continue
		}
		name = filepath.Base(strings.ReplaceAll(part.FileName(), "\\", "/"))
		if !strings.EqualFold(filepath.Ext(name), ".dem") {
			apiError(w, 400, "仅支持未压缩的 CS2 .dem 文件，请先解压 .zip 或 .bz2")
			return
		}
		magic := make([]byte, 8)
		if _, err = io.ReadFull(part, magic); err != nil || string(magic) != "PBDEMS2\x00" {
			apiError(w, 400, "这不是有效的 CS2 Demo 文件（需要 PBDEMS2 文件头）")
			return
		}
		f, e := os.CreateTemp(a.root, "upload-*.dem")
		if e != nil {
			apiError(w, 500, "无法创建本地临时文件")
			return
		}
		source = f.Name()
		n, copyErr := io.Copy(f, io.LimitReader(io.MultiReader(strings.NewReader(string(magic)), part), maxUploadBytes+1))
		closeErr := f.Close()
		if copyErr != nil || closeErr != nil || r.Context().Err() != nil {
			apiError(w, 400, "文件上传中断，请重新导入")
			return
		}
		if n > maxUploadBytes {
			apiError(w, 413, "Demo 超过 2 GB 限制")
			return
		}
		break
	}
	if source == "" {
		apiError(w, 400, "请求中没有名为 demo 的文件")
		return
	}
	b := make([]byte, 12)
	if _, err = rand.Read(b); err != nil {
		apiError(w, 500, "无法创建解析任务")
		return
	}
	id := hex.EncodeToString(b)
	ctx, cancel := context.WithCancel(a.ctx)
	j := &job{ID: id, Status: "queued", Message: "已上传，等待解析", name: name, source: source, result: filepath.Join(a.root, id+".json.gz"), created: time.Now(), ctx: ctx, cancel: cancel}
	a.mu.Lock()
	// Keep a small recent history; raw uploads are removed immediately after parsing.
	if len(a.jobs) >= 6 {
		var oldest *job
		for _, x := range a.jobs {
			x.mu.Lock()
			done := x.Status == "ready" || x.Status == "error"
			x.mu.Unlock()
			if done && (oldest == nil || x.created.Before(oldest.created)) {
				oldest = x
			}
		}
		if oldest != nil {
			delete(a.jobs, oldest.ID)
			_ = os.Remove(oldest.result)
			oldest.cancel()
		}
	}
	a.jobs[id] = j
	a.mu.Unlock()
	select {
	case a.queue <- j:
		queued = true
	case <-a.ctx.Done():
		cancel()
		apiError(w, 503, "服务正在关闭")
		return
	}
	jsonResponse(w, 202, map[string]string{"id": id})
}

func (a *app) getJob(r *http.Request) *job {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.jobs[r.PathValue("id")]
}
func (a *app) status(w http.ResponseWriter, r *http.Request) {
	j := a.getJob(r)
	if j == nil {
		apiError(w, 404, "任务不存在，请重新导入")
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	jsonResponse(w, 200, j)
}
func (a *app) result(w http.ResponseWriter, r *http.Request) {
	j := a.getJob(r)
	if j == nil {
		apiError(w, 404, "任务不存在，请重新导入")
		return
	}
	j.mu.Lock()
	state, path := j.Status, j.result
	j.mu.Unlock()
	if state != "ready" {
		apiError(w, 409, "Demo 尚未完成解析")
		return
	}
	f, err := os.Open(path)
	if err != nil {
		apiError(w, 404, "回放缓存已释放，请重新导入")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Vary", "Accept-Encoding")
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = io.Copy(w, f)
	} else {
		gz, e := gzip.NewReader(f)
		if e != nil {
			apiError(w, 500, "回放缓存读取失败")
			return
		}
		defer gz.Close()
		_, _ = io.Copy(w, gz)
	}
}
func (a *app) remove(w http.ResponseWriter, r *http.Request) {
	j := a.getJob(r)
	if j == nil {
		w.WriteHeader(204)
		return
	}
	j.cancel()
	a.mu.Lock()
	delete(a.jobs, j.ID)
	a.mu.Unlock()
	_ = os.Remove(j.result)
	w.WriteHeader(204)
}
func (a *app) mapInfo(w http.ResponseWriter, r *http.Request) {
	content, err := fs.ReadFile(a.assets, "maps/manifest.json")
	if err != nil {
		apiError(w, 404, "没有可用地图资源")
		return
	}
	var maps map[string]json.RawMessage
	if json.Unmarshal(content, &maps) != nil {
		apiError(w, 500, "地图配置读取失败")
		return
	}
	m, ok := maps[r.PathValue("map")]
	if !ok {
		apiError(w, 404, "此地图暂无雷达图，将使用坐标网格")
		return
	}
	jsonResponse(w, 200, m)
}

func (a *app) worker() {
	defer a.wg.Done()
	for {
		select {
		case <-a.ctx.Done():
			return
		case j := <-a.queue:
			a.process(j)
			<-a.slots
		}
	}
}
func (a *app) process(j *job) {
	defer os.Remove(j.source)
	if j.ctx.Err() != nil {
		return
	}
	j.mu.Lock()
	j.Status = "parsing"
	j.Message = "正在本地解析比赛"
	j.mu.Unlock()
	d, err := parseDemo(j.ctx, j.source, j.ID, j.name, func(p float64) { j.mu.Lock(); j.Progress = p; j.mu.Unlock() })
	if err == nil && j.ctx.Err() == nil {
		j.mu.Lock()
		j.Message = "正在准备回放数据"
		j.mu.Unlock()
		var f *os.File
		f, err = os.Create(j.result)
		if err == nil {
			gz, _ := gzip.NewWriterLevel(f, gzip.BestSpeed)
			err = json.NewEncoder(gz).Encode(d)
			if e := gz.Close(); err == nil {
				err = e
			}
			if e := f.Close(); err == nil {
				err = e
			}
		}
	}
	if j.ctx.Err() != nil {
		_ = os.Remove(j.result)
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if err != nil {
		j.Status = "error"
		j.Error = err.Error()
		j.Message = "解析未完成"
		_ = os.Remove(j.result)
		log.Printf("parse %s: %v", j.name, err)
		return
	}
	j.Status = "ready"
	j.Progress = 1
	j.Message = "回放已就绪"
	log.Printf("Parsed %s: %s, %d rounds, %d frames, %.1f seconds", j.name, d.Map, len(d.Rounds), len(d.Frames), d.Duration)
}
