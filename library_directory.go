package main

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func sameDirectory(first, second string) bool {
	if rel, err := filepath.Rel(first, second); err == nil && rel == "." {
		return true
	}
	one, err1 := os.Stat(first)
	two, err2 := os.Stat(second)
	return err1 == nil && err2 == nil && os.SameFile(one, two)
}

func (a *app) manifestDirectory(directory string) *string {
	// Use only the lexical check here: a disconnected removable drive
	// should never slow down routine manifest writes.
	if rel, err := filepath.Rel(a.defaultDemoDir, directory); err == nil && rel == "." {
		directory = ""
	}
	return &directory
}

func (m *libraryManifest) detachDirectorySources() {
	m.Sources = nil
	kept := m.Jobs[:0]
	for _, entry := range m.Jobs {
		if !entry.OwnedSource {
			if entry.Status != "ready" && !entry.Analysis {
				continue
			}
			entry.Source, entry.SourceSize, entry.SourceModTime = "", 0, 0
		}
		kept = append(kept, entry)
	}
	m.Jobs = kept
}

func (a *app) checkedLibraryDirectory(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", errors.New("请输入录像文件夹的绝对路径")
	}
	path, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return "", errors.New("找不到该录像文件夹或无法访问，请检查路径")
	}
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return "", errors.New("请选择一个现有的文件夹")
	}
	privateDir, err := filepath.EvalSymlinks(a.root)
	if err != nil || sameDirectory(path, privateDir) || containedFile(privateDir, path) {
		return "", errors.New("请选择录像所在文件夹，程序的 data 缓存目录不能作为录像来源")
	}
	f, err := os.Open(path)
	if err == nil {
		_, err = f.Readdirnames(1)
		f.Close()
	}
	if err != nil && !errors.Is(err, io.EOF) {
		return "", errors.New("无法读取文件夹，请检查访问权限")
	}
	return path, nil
}

func (a *app) changeLibraryDirectory(w http.ResponseWriter, r *http.Request) {
	if !a.persistent {
		apiError(w, http.StatusConflict, "此实例未启用本机资料库")
		return
	}
	contentType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if contentType != "application/json" {
		apiError(w, http.StatusUnsupportedMediaType, "请使用 application/json")
		return
	}
	var input struct {
		Directory string `json:"directory"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || strings.TrimSpace(input.Directory) == "" {
		apiError(w, http.StatusBadRequest, "请提供一个录像文件夹路径")
		return
	}
	directory, err := a.checkedLibraryDirectory(input.Directory)
	if err != nil {
		apiError(w, http.StatusBadRequest, err.Error())
		return
	}
	result, status, err := a.switchLibraryDirectory(directory)
	if err != nil {
		apiError(w, status, err.Error())
		return
	}
	jsonResponse(w, status, result)
}

func (a *app) switchLibraryDirectory(directory string) (libraryScan, int, error) {
	// Match persistLibrary and commitReparse lock order. The new root and the
	// removal of old relative bindings must reach disk as one transaction.
	a.persistMu.Lock()
	defer a.persistMu.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.ctx.Err() != nil {
		return libraryScan{}, http.StatusServiceUnavailable, errors.New("服务正在关闭")
	}
	if sameDirectory(directory, a.demoDir) {
		return a.startLibraryScanLocked(), http.StatusOK, nil
	}
	if a.scanning {
		return libraryScan{}, http.StatusConflict, errors.New("正在扫描录像文件夹，请在扫描完成后重试")
	}
	for _, j := range a.jobs {
		j.mu.Lock()
		busy := j.Status == "queued" || j.Status == "parsing" || j.reparseStage != nil
		j.mu.Unlock()
		if busy {
			return libraryScan{}, http.StatusConflict, errors.New("正在解析录像，请在解析完成后重试")
		}
	}
	if sameDirectory(directory, a.defaultDemoDir) {
		directory = a.defaultDemoDir
	}
	manifest := a.libraryManifestLocked(nil)
	manifest.Directory = a.manifestDirectory(directory)
	manifest.detachDirectorySources()
	if err := a.writeLibraryManifest(manifest); err != nil {
		return libraryScan{}, http.StatusInternalServerError, errors.New("保存录像文件夹设置失败，请检查 data 目录的写入权限")
	}
	kept := make(map[string]*job, len(manifest.Jobs))
	for _, entry := range manifest.Jobs {
		j := a.jobs[entry.ID]
		kept[j.ID] = j
		if !entry.OwnedSource {
			j.mu.Lock()
			j.source, j.sourceSize, j.sourceModTime = "", 0, 0
			j.mu.Unlock()
		}
	}
	for id, j := range a.jobs {
		if kept[id] == nil {
			j.cancel()
		}
	}
	a.jobs = kept
	clear(a.sources)
	a.demoDir = directory
	return a.startLibraryScanLocked(), http.StatusOK, nil
}
