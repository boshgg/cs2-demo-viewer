package main

import (
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxUploadBytes int64 = 2 << 30
const maxReplayHistory = 6

type job struct {
	mu                   sync.Mutex
	ID                   string        `json:"id"`
	Revision             string        `json:"revision"`
	Status               string        `json:"status"`
	Progress             float64       `json:"progress"`
	Message              string        `json:"message,omitempty"`
	Error                string        `json:"error,omitempty"`
	Name                 string        `json:"name"`
	Map                  string        `json:"map,omitempty"`
	Analysis             bool          `json:"analysis"`
	Reparse              *reparseState `json:"reparse,omitempty"`
	name, source, result string
	analysisResult       string
	ownedSource          bool
	sourceSize           int64
	sourceModTime        int64
	contentSHA256        string
	catalog              bool
	created              time.Time
	ctx                  context.Context
	cancel               context.CancelFunc
	reparseStage         *job
	reparseBase          *job
	reparseBaseRevision  string
	stopBaseCancellation func() bool
}

type app struct {
	root                    string
	assets                  fs.FS
	mu                      sync.Mutex
	jobs                    map[string]*job
	queue                   chan struct{}
	pending                 []*job
	slots                   chan struct{}
	ctx                     context.Context
	cancel                  context.CancelFunc
	wg                      sync.WaitGroup
	sessionID               string
	sessionSettings         json.RawMessage
	persistent              bool
	demoDir                 string
	defaultDemoDir          string
	persistMu               sync.Mutex
	scanMu                  sync.Mutex
	scanning                bool
	scanResult              libraryScan
	sources                 map[string]librarySource
	libraryLock             *os.File
	closeOnce               sync.Once
	statisticsGate          chan struct{}
	insightsGate            chan struct{}
	statisticsKey           string
	statisticsJSON          []byte
	analysisUpgradeGate     chan struct{}
	analysisUpgradeFailures map[string]analysisUpgradeFailure
	reparseParser           func(context.Context, string, string, string, func(float64)) (*DemoData, error)
}

func newApp(root string, assets fs.FS) *app {
	ctx, cancel := context.WithCancel(context.Background())
	a := &app{root: root, assets: assets, jobs: map[string]*job{}, sources: map[string]librarySource{}, queue: make(chan struct{}, 1), slots: make(chan struct{}, 3), statisticsGate: make(chan struct{}, 1), analysisUpgradeGate: make(chan struct{}, 1), analysisUpgradeFailures: map[string]analysisUpgradeFailure{}, ctx: ctx, cancel: cancel}
	a.insightsGate = make(chan struct{}, 2)
	a.wg.Add(1)
	go a.worker()
	return a
}

func (a *app) close() {
	a.closeOnce.Do(func() {
		a.mu.Lock()
		a.cancel()
		a.mu.Unlock()
		a.wg.Wait()
		if a.persistent {
			a.saveLibrary()
			if a.libraryLock != nil {
				_ = a.libraryLock.Close()
			}
			return
		}
		// Only delete generated files in this instance's private temp directory.
		entries, _ := os.ReadDir(a.root)
		for _, e := range entries {
			if !e.IsDir() {
				_ = os.Remove(filepath.Join(a.root, e.Name()))
			}
		}
		_ = os.Remove(a.root)
	})
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
		jsonResponse(w, 200, map[string]any{"app": "cs2-local-viewer", "version": appVersion, "parser": parserVersion})
	})
	mux.HandleFunc("POST /api/demos", a.upload)
	mux.HandleFunc("GET /api/demos/{id}/status", a.status)
	mux.HandleFunc("GET /api/demos/{id}/analysis", a.analysisResult)
	mux.HandleFunc("GET /api/demos/{id}/statistics", a.statisticsResult)
	mux.HandleFunc("GET /api/analyses", a.analyses)
	mux.HandleFunc("GET /api/insights/config", insightsConfig)
	mux.HandleFunc("GET /api/insights/mcp-config", insightsMCPConfig)
	mux.HandleFunc("POST /api/insights/evidence", a.insightsEvidence)
	mux.HandleFunc("POST /api/insights/ask", a.insightsAsk)
	mux.HandleFunc("DELETE /api/analyses/{id}", a.removeAnalysis)
	mux.HandleFunc("GET /api/session-settings", a.sessionSettingsResult)
	mux.HandleFunc("GET /api/library", a.libraryInfo)
	mux.HandleFunc("POST /api/library/directory", a.changeLibraryDirectory)
	mux.HandleFunc("POST /api/library/directory/pick", a.pickLibraryDirectory)
	mux.HandleFunc("GET /api/library/demos", a.libraryDemos)
	mux.HandleFunc("POST /api/library/demos/{id}/parse", a.parseLibraryDemo)
	mux.HandleFunc("DELETE /api/library/demos/{id}", a.removeLibraryDemo)
	mux.HandleFunc("POST /api/library/refresh", a.refreshLibrary)
	mux.HandleFunc("POST /api/library/reparse", a.reparseLibrary)
	mux.HandleFunc("GET /api/demos/{id}", a.result)
	mux.HandleFunc("DELETE /api/demos/{id}", a.remove)
	mux.HandleFunc("GET /api/maps/{map}", a.mapInfo)
	mux.HandleFunc("GET /api/sample", func(w http.ResponseWriter, r *http.Request) { jsonResponse(w, 200, sampleDemo()) })
	mux.HandleFunc("GET /api/sample/analysis", func(w http.ResponseWriter, r *http.Request) { jsonResponse(w, 200, BuildAnalysis(sampleDemo())) })
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
		imageSources := "'self' data:"
		if r.URL.Path == "/insights.html" {
			// External model images load only when the user requests a preview.
			imageSources += " https:"
		}
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src "+imageSources+"; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
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
	analysis := r.URL.Query().Get("mode") == "analysis"
	select {
	case a.slots <- struct{}{}:
	default:
		apiError(w, 429, "已有文件正在处理，请稍后再导入")
		return
	}
	queued := false
	defer func() { <-a.slots }()
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes+(256<<10))
	reader, err := r.MultipartReader()
	if err != nil {
		apiError(w, 400, "请选择 .dem 文件")
		return
	}
	var source, name, contentHash string
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
		hash := sha256.New()
		n, copyErr := io.Copy(io.MultiWriter(f, hash), io.LimitReader(io.MultiReader(strings.NewReader(string(magic)), part), maxUploadBytes+1))
		contentHash = hex.EncodeToString(hash.Sum(nil))
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
	j := &job{ID: id, Name: name, Analysis: analysis, Status: "queued", Message: "已上传，等待解析", name: name, source: source, ownedSource: true, contentSHA256: contentHash, catalog: a.persistent, result: filepath.Join(a.root, id+".json.gz"), analysisResult: filepath.Join(a.root, id+".analysis.json.gz"), created: time.Now(), ctx: ctx, cancel: cancel}
	a.mu.Lock()
	if a.persistent {
		var existing *job
		for _, candidate := range a.jobs {
			candidate.mu.Lock()
			same := candidate.contentSHA256 == contentHash
			candidate.mu.Unlock()
			if same && (existing == nil || (usableJob(candidate) && !usableJob(existing)) || (usableJob(candidate) == usableJob(existing) && candidate.created.Before(existing.created))) {
				existing = candidate
			}
		}
		if existing != nil {
			if usableJob(existing) {
				existing.mu.Lock()
				existing.Analysis = existing.Analysis || analysis
				existing.catalog = true
				existing.mu.Unlock()
				a.mu.Unlock()
				cancel()
				a.saveLibrary()
				jsonResponse(w, 202, map[string]any{"id": existing.ID, "shared": true})
				return
			}
			existing.mu.Lock()
			j.ID, j.Name, j.name, j.Map, j.created = existing.ID, existing.Name, existing.name, existing.Map, existing.created
			j.Analysis = existing.Analysis || analysis
			existing.mu.Unlock()
			existing.cancel()
			j.Revision = fmt.Sprintf("%s-%d", j.ID, time.Now().UnixNano())
			j.result, j.analysisResult = jobCachePaths(a.root, j.ID, j.Revision)
			a.jobs[j.ID] = j
			a.pending = append(a.pending, j)
			a.mu.Unlock()
			_ = os.Remove(existing.result)
			_ = os.Remove(existing.analysisResult)
			queued = true
			select {
			case a.queue <- struct{}{}:
			default:
			}
			a.saveLibrary()
			jsonResponse(w, 202, map[string]any{"id": j.ID, "shared": true})
			return
		}
	}
	// Analysis jobs are never silently evicted. Ordinary playback keeps a small
	// recent list; sequential parsing remains bounded independently of count.
	replayCount := 0
	for _, x := range a.jobs {
		if !x.Analysis && !x.catalog {
			replayCount++
		}
	}
	if !analysis && replayCount >= maxReplayHistory {
		var oldest *job
		for _, x := range a.jobs {
			x.mu.Lock()
			done := x.Status == "ready" || x.Status == "error"
			x.mu.Unlock()
			if !x.Analysis && !x.catalog && done && (oldest == nil || x.created.Before(oldest.created)) {
				oldest = x
			}
		}
		if oldest != nil {
			delete(a.jobs, oldest.ID)
			_ = os.Remove(oldest.result)
			_ = os.Remove(oldest.analysisResult)
			if oldest.ownedSource {
				_ = os.Remove(oldest.source)
			}
			oldest.cancel()
		}
	}
	j.Revision = id
	a.jobs[id] = j
	a.mu.Unlock()
	if !a.enqueue(j) {
		cancel()
		a.mu.Lock()
		delete(a.jobs, id)
		a.mu.Unlock()
		apiError(w, 503, "服务正在关闭")
		return
	}
	queued = true
	a.saveLibrary()
	jsonResponse(w, 202, map[string]any{"id": id, "shared": a.persistent})
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
	a.serveResult(w, r, false)
}

func (a *app) analysisResult(w http.ResponseWriter, r *http.Request) {
	a.serveResult(w, r, true)
}

func (a *app) serveResult(w http.ResponseWriter, r *http.Request, analysis bool) {
	j := a.getJob(r)
	if j == nil {
		apiError(w, 404, "任务不存在，请重新导入")
		return
	}
	j.mu.Lock()
	state, path := j.Status, j.result
	if analysis {
		path = j.analysisResult
	}
	j.mu.Unlock()
	if state != "ready" {
		apiError(w, 409, "Demo 尚未完成解析")
		return
	}
	if analysis {
		fallback, err := a.ensureAnalysisUtilityTiming(r.Context(), j)
		if err != nil {
			if errors.Is(err, errAnalysisUpgradeStale) {
				apiError(w, 409, "录像已更新或移除，请重新读取分析数据")
			} else if r.Context().Err() == nil {
				apiError(w, 500, "分析缓存读取失败")
			}
			return
		}
		if fallback != nil {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Vary", "Accept-Encoding")
			if acceptsGzip(r.Header.Get("Accept-Encoding")) {
				w.Header().Set("Content-Encoding", "gzip")
				gz, _ := gzip.NewWriterLevel(w, gzip.BestSpeed)
				_, _ = gz.Write(fallback)
				_ = gz.Close()
			} else {
				_, _ = w.Write(fallback)
			}
			return
		}
	}
	f, err := os.Open(path)
	if err != nil {
		apiError(w, 404, "回放缓存已释放，请重新导入")
		return
	}
	defer func() {
		_ = f.Close()
		// Windows cannot unlink an open cache. DELETE may have raced with
		// this response; retry only this generated file after closing it.
		if j.ctx != nil && j.ctx.Err() != nil && (!a.persistent || a.ctx.Err() == nil) {
			_ = os.Remove(path)
		}
	}()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Vary", "Accept-Encoding")
	if acceptsGzip(r.Header.Get("Accept-Encoding")) {
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

func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(part, ";")
		if !strings.EqualFold(strings.TrimSpace(fields[0]), "gzip") {
			continue
		}
		quality := 1.0
		for _, parameter := range fields[1:] {
			pair := strings.SplitN(strings.TrimSpace(parameter), "=", 2)
			if len(pair) == 2 && strings.EqualFold(pair[0], "q") {
				value, err := strconv.ParseFloat(strings.TrimSpace(pair[1]), 64)
				if err != nil || value < 0 || value > 1 {
					quality = 0
				} else {
					quality = value
				}
			}
		}
		return quality > 0
	}
	return false
}

func (a *app) analyses(w http.ResponseWriter, r *http.Request) {
	// Copy metadata while holding each job's lock. Never decode ten full demos
	// just to populate the analysis library.
	a.mu.Lock()
	jobs := make([]*job, 0, len(a.jobs))
	for _, j := range a.jobs {
		j.mu.Lock()
		included := j.Analysis && j.Status != "discovered"
		j.mu.Unlock()
		if included {
			jobs = append(jobs, j)
		}
	}
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].created.Before(jobs[j].created) })
	items := make([]map[string]any, 0, len(jobs))
	for _, j := range jobs {
		j.mu.Lock()
		items = append(items, map[string]any{"id": j.ID, "revision": j.Revision, "name": j.Name, "map": j.Map, "analysis": true, "status": j.Status, "progress": j.Progress, "message": j.Message, "error": j.Error, "reparse": copyReparseState(j.Reparse)})
		j.mu.Unlock()
	}
	a.mu.Unlock()
	jsonResponse(w, 200, map[string]any{"demos": items, "maxDemos": 0})
}

func (a *app) remove(w http.ResponseWriter, r *http.Request) {
	a.removeJob(w, r, false)
}
func (a *app) removeLibraryDemo(w http.ResponseWriter, r *http.Request) {
	a.removeJob(w, r, true)
}
func (a *app) removeJob(w http.ResponseWriter, r *http.Request, explicitLibraryRemoval bool) {
	a.mu.Lock()
	j := a.jobs[r.PathValue("id")]
	if j == nil {
		a.mu.Unlock()
		w.WriteHeader(204)
		return
	}
	if !explicitLibraryRemoval && (j.catalog || a.persistent) {
		a.mu.Unlock()
		apiError(w, 409, "共享资料库录像不会因取消等待而删除；退出分析请使用分析列表操作")
		return
	}
	j.cancel()
	delete(a.jobs, j.ID)
	for key, source := range a.sources {
		if source.JobID == j.ID {
			delete(a.sources, key)
		}
	}
	j.mu.Lock()
	ownedSource, sourcePath := j.ownedSource, j.source
	j.mu.Unlock()
	a.mu.Unlock()
	_ = os.Remove(j.result)
	_ = os.Remove(j.analysisResult)
	if ownedSource {
		_ = os.Remove(sourcePath)
	}
	a.saveLibrary()
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
		if a.ctx.Err() != nil {
			return
		}
		a.mu.Lock()
		var j *job
		if len(a.pending) > 0 {
			j, a.pending = a.pending[0], a.pending[1:]
		}
		a.mu.Unlock()
		if j != nil {
			if j.reparseBase != nil {
				a.processReparse(j)
			} else {
				a.process(j)
			}
			continue
		}
		select {
		case <-a.ctx.Done():
			return
		case <-a.queue:
		}
	}
}
func (a *app) process(j *job) {
	defer a.cleanupDeletedSource(j)
	if !a.persistent && j.ownedSource {
		defer os.Remove(j.source)
	}
	defer a.saveLibrary()
	defer a.cleanupCompletedUpload(j)
	if j.ctx.Err() != nil {
		return
	}
	j.mu.Lock()
	j.Status = "parsing"
	j.Message = "正在本地解析比赛"
	j.mu.Unlock()
	parseSource, cleanup, err := a.snapshotDemo(j)
	defer cleanup()
	var d *DemoData
	if err == nil {
		d, err = parseDemo(j.ctx, parseSource, j.ID, j.name, func(p float64) { j.mu.Lock(); j.Progress = p; j.mu.Unlock() })
	}
	if err == nil && j.ctx.Err() == nil {
		j.mu.Lock()
		j.Message = "正在准备回放与热力图分析数据"
		j.Map = d.Map
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
		if err == nil && j.ctx.Err() == nil {
			err = writeAnalysisCache(j.analysisResult, BuildAnalysis(d))
		}
	}
	if j.ctx.Err() != nil {
		_ = os.Remove(j.result)
		_ = os.Remove(j.analysisResult)
		if a.persistent && a.ctx.Err() != nil {
			j.mu.Lock()
			j.Status = "discovered"
			j.Message = "解析已中断，选择录像后可重新开始"
			j.mu.Unlock()
		}
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if err != nil {
		j.Status = "error"
		j.Error = err.Error()
		j.Message = "解析未完成"
		_ = os.Remove(j.result)
		_ = os.Remove(j.analysisResult)
		diagnostic := err
		var parseError *demoReadError
		if errors.As(err, &parseError) {
			diagnostic = parseError.Unwrap()
		}
		log.Printf("parse %s: %v", j.name, diagnostic)
		return
	}
	j.Status = "ready"
	j.Progress = 1
	j.Message = "回放已就绪"
	log.Printf("Parsed %s: %s, %d rounds, %d frames, %.1f seconds", j.name, d.Map, len(d.Rounds), len(d.Frames), d.Duration)
}

func writeAnalysisCache(path string, data *AnalysisDemo) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	gz, _ := gzip.NewWriterLevel(f, gzip.BestSpeed)
	err = json.NewEncoder(gz).Encode(data)
	if e := gz.Close(); err == nil {
		err = e
	}
	if e := f.Close(); err == nil {
		err = e
	}
	return err
}
