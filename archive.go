package main

import (
	"archive/zip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// Source bindings outlive private extracted files. Multiple verified sources may
// refer to one analysis; changing one of those sources must not mutate the others.
type librarySource struct {
	Source        string `json:"source"`
	Member        string `json:"member,omitempty"`
	SourceSize    int64  `json:"sourceSize"`
	SourceModTime int64  `json:"sourceModTime"`
	MemberSize    int64  `json:"memberSize"`
	MemberCRC     uint32 `json:"memberCRC,omitempty"`
	ContentSHA256 string `json:"contentSHA256"`
	JobID         string `json:"jobId"`
}

func sourceKey(s librarySource) string {
	return strings.ToLower(filepath.Clean(s.Source)) + "\x00" + s.Member
}

func safeArchiveMember(name string) bool {
	if name == "" || strings.ContainsAny(name, "\\:\x00") || strings.HasPrefix(name, "/") || path.Clean(name) != name {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return strings.EqualFold(path.Ext(name), ".dem")
}

func validLibrarySource(dir string, s librarySource) bool {
	if !containedFile(dir, s.Source) || !validSessionID(s.JobID) || !validSessionHash(s.ContentSHA256) || s.SourceSize <= 0 || s.MemberSize <= 0 || s.MemberSize > maxUploadBytes {
		return false
	}
	if s.Member == "" {
		return strings.EqualFold(filepath.Ext(s.Source), ".dem") && s.SourceSize == s.MemberSize
	}
	return strings.EqualFold(filepath.Ext(s.Source), ".zip") && safeArchiveMember(s.Member)
}

func (a *app) startLibraryScan() libraryScan {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.scanning || a.ctx.Err() != nil {
		result := a.scanResult
		result.Scanning = a.scanning
		result.Errors = append([]string{}, result.Errors...)
		return result
	}
	a.scanning = true
	a.scanResult = libraryScan{Directory: a.demoDir, Scanning: true, Errors: []string{}}
	// close() cancels under the same mutex before waiting, so Add cannot race Wait.
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		result, _ := a.scanLibrary()
		for _, message := range result.Errors {
			log.Printf("Scan demo directory: %s", message)
		}
	}()
	return a.scanResult
}

func (a *app) publishScanProgress(result libraryScan) {
	result.Scanning = true
	result.Errors = append([]string{}, result.Errors...)
	a.mu.Lock()
	a.scanResult = result
	a.mu.Unlock()
}

func sourceUnchanged(a, b librarySource) bool {
	return a.SourceSize == b.SourceSize && a.SourceModTime == b.SourceModTime && a.MemberSize == b.MemberSize && a.MemberCRC == b.MemberCRC
}

// Caller holds a.mu; cache existence is checked so a deleted cache can be rebuilt.
func usableJob(j *job) bool {
	if j == nil {
		return false
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.Status == "queued" || j.Status == "parsing" || (j.Status == "ready" && cacheExists(j.result) && cacheExists(j.analysisResult))
}

func (a *app) reuseSource(s librarySource) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	previous, ok := a.sources[sourceKey(s)]
	return ok && sourceUnchanged(previous, s) && a.jobs[previous.JobID] != nil
}

func (a *app) scanPlainFile(file string, info os.FileInfo, result *libraryScan) error {
	if !safeSourcePath(a.demoDir, file) {
		return fmt.Errorf("跳过不安全或含链接的来源")
	}
	source := librarySource{Source: file, SourceSize: info.Size(), SourceModTime: info.ModTime().UnixNano(), MemberSize: info.Size()}
	if a.reuseSource(source) {
		result.Unchanged++
		return nil
	}
	hash, err := hashStableFile(a.ctx, file, info)
	if err != nil {
		return err
	}
	source.ContentSHA256 = hash
	// v4.0.4 has no source registry/hash. Bind only the exact original path and
	// recorded file identity, preserving its ID/cache while filling the hash.
	a.mu.Lock()
	for _, existing := range a.jobs {
		if existing.ownedSource || !strings.EqualFold(existing.source, file) {
			continue
		}
		existing.mu.Lock()
		unchanged := existing.sourceSize == info.Size() && existing.sourceModTime == info.ModTime().UnixNano() && (existing.contentSHA256 == "" || existing.contentSHA256 == hash)
		existing.mu.Unlock()
		if unchanged && usableJob(existing) {
			existing.mu.Lock()
			existing.contentSHA256 = hash
			existing.catalog = true
			existing.mu.Unlock()
			source.JobID = existing.ID
			a.sources[sourceKey(source)] = source
			a.mu.Unlock()
			result.Unchanged++
			return nil
		}
	}
	a.mu.Unlock()
	_, _, err = a.registerSource(source, filepath.Base(file), file, false, result)
	return err
}

func hashStableFile(ctx context.Context, file string, expected os.FileInfo) (string, error) {
	input, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer input.Close()
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(contextReader{ctx, input}, maxUploadBytes+1))
	if err != nil {
		return "", err
	}
	after, err := os.Lstat(file)
	if err != nil || !after.Mode().IsRegular() || n != expected.Size() || after.Size() != expected.Size() || after.ModTime() != expected.ModTime() {
		return "", fmt.Errorf("文件仍在写入，请完成后刷新重试")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func (a *app) scanArchive(file string, info os.FileInfo, result *libraryScan) error {
	if !safeSourcePath(a.demoDir, file) {
		return fmt.Errorf("跳过不安全或含链接的来源")
	}
	archive, err := zip.OpenReader(file)
	if err != nil {
		return fmt.Errorf("无法打开 ZIP（可能尚未下载完成或已损坏）：%w", err)
	}
	defer archive.Close()
	seen, found := map[string]bool{}, false
	for _, member := range archive.File {
		if a.ctx.Err() != nil {
			return a.ctx.Err()
		}
		if !strings.EqualFold(path.Ext(strings.ReplaceAll(member.Name, "\\", "/")), ".dem") || member.FileInfo().IsDir() {
			continue
		}
		found = true
		if !safeArchiveMember(member.Name) || !member.Mode().IsRegular() || seen[member.Name] {
			result.Errors = append(result.Errors, filepath.Base(file)+" / "+member.Name+"：不支持的成员路径、链接或重复成员名")
			continue
		}
		seen[member.Name] = true
		if member.UncompressedSize64 == 0 || member.UncompressedSize64 > uint64(maxUploadBytes) {
			result.Errors = append(result.Errors, filepath.Base(file)+" / "+member.Name+"：解压后为空或超过 2 GiB")
			continue
		}
		source := librarySource{Source: file, Member: member.Name, SourceSize: info.Size(), SourceModTime: info.ModTime().UnixNano(), MemberSize: int64(member.UncompressedSize64), MemberCRC: member.CRC32}
		if a.reuseSource(source) {
			result.Unchanged++
			continue
		}
		extracted, hash, err := a.extractArchiveMember(member, file, info)
		if err != nil {
			result.Errors = append(result.Errors, filepath.Base(file)+" / "+member.Name+"："+err.Error())
			continue
		}
		source.ContentSHA256 = hash
		_, _, err = a.registerSource(source, path.Base(member.Name), "", false, result)
		_ = os.Remove(extracted)
		if err != nil {
			return err
		}
		a.publishScanProgress(*result)
	}
	if !found {
		return fmt.Errorf("压缩包内未找到 .dem 文件")
	}
	return nil
}

func (a *app) extractArchiveMember(member *zip.File, source string, expected os.FileInfo) (file, hash string, err error) {
	if member.UncompressedSize64 == 0 || member.UncompressedSize64 > uint64(maxUploadBytes) || !safeArchiveMember(member.Name) || !member.Mode().IsRegular() {
		return "", "", fmt.Errorf("不支持的 ZIP 成员")
	}
	input, err := member.Open()
	if err != nil {
		return "", "", err
	}
	defer input.Close()
	output, err := os.CreateTemp(a.root, "extract-*.dem")
	if err != nil {
		return "", "", err
	}
	file = output.Name()
	defer func() {
		if err != nil {
			_ = os.Remove(file)
		}
	}()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(output, h), io.LimitReader(contextReader{a.ctx, input}, maxUploadBytes+1))
	if closeErr := output.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return file, "", fmt.Errorf("解压或 CRC 校验失败：%w", err)
	}
	if n != int64(member.UncompressedSize64) || n > maxUploadBytes {
		return file, "", fmt.Errorf("解压大小不符或超过 2 GiB")
	}
	after, statErr := os.Lstat(source)
	if statErr != nil || !after.Mode().IsRegular() || after.Size() != expected.Size() || after.ModTime() != expected.ModTime() {
		return file, "", fmt.Errorf("ZIP 在读取期间变化，请下载完成后刷新重试")
	}
	return file, hex.EncodeToString(h.Sum(nil)), nil
}

// Discovery records content identity, but never runs or enqueues the demo parser.
// The second return value stays false: scanner scratch files are never retained.
func (a *app) registerSource(source librarySource, name, parseFile string, owned bool, result *libraryScan) (*job, bool, error) {
	a.mu.Lock()
	if a.ctx.Err() != nil {
		a.mu.Unlock()
		return nil, false, a.ctx.Err()
	}
	key := sourceKey(source)
	previous := a.sources[key]
	existing := a.jobs[previous.JobID]
	if existing == nil && source.Member == "" {
		for _, candidate := range a.jobs {
			if !candidate.ownedSource && strings.EqualFold(candidate.source, source.Source) {
				existing = candidate
				break
			}
		}
	}
	var canonical *job
	for _, candidate := range a.jobs {
		candidate.mu.Lock()
		equal := candidate.contentSHA256 == source.ContentSHA256
		candidate.mu.Unlock()
		if equal && (canonical == nil || (usableJob(candidate) && !usableJob(canonical)) || (usableJob(candidate) == usableJob(canonical) && candidate.created.Before(canonical.created))) {
			canonical = candidate
		}
	}
	if canonical != nil {
		canonical.mu.Lock()
		canonical.catalog = true
		canonical.mu.Unlock()
		source.JobID = canonical.ID
		a.sources[key] = source
		a.mu.Unlock()
		result.Unchanged++
		return canonical, false, nil
	}
	if existing != nil {
		shared := false
		for otherKey, binding := range a.sources {
			if otherKey != key && binding.JobID == existing.ID {
				shared = true
				break
			}
		}
		if !existing.ownedSource && existing.source != "" && !strings.EqualFold(existing.source, source.Source) {
			shared = true
		}
		existing.mu.Lock()
		changedContent := existing.contentSHA256 != source.ContentSHA256
		existing.mu.Unlock()
		if shared && changedContent {
			existing = nil
		}
	}
	id := ""
	created := time.Now()
	if existing != nil {
		id = existing.ID
		created = existing.created
	} else {
		b := make([]byte, 12)
		if _, err := rand.Read(b); err != nil {
			a.mu.Unlock()
			return nil, false, err
		}
		id = hex.EncodeToString(b)
	}
	ctx, cancel := context.WithCancel(a.ctx)
	analysis := false
	if existing != nil {
		existing.mu.Lock()
		analysis = existing.Analysis
		existing.mu.Unlock()
	}
	j := &job{ID: id, Revision: fmt.Sprintf("%s-%d", id, time.Now().UnixNano()), Name: name, name: name, Analysis: analysis, Status: "discovered", Message: "已发现录像，选择后解析", source: parseFile, ownedSource: owned, contentSHA256: source.ContentSHA256, catalog: true, sourceSize: source.MemberSize, sourceModTime: source.SourceModTime, created: created, ctx: ctx, cancel: cancel}
	j.result, j.analysisResult = jobCachePaths(a.root, j.ID, j.Revision)
	if existing != nil {
		existing.cancel()
	}
	a.jobs[id] = j
	source.JobID = id
	a.sources[key] = source
	a.mu.Unlock()
	if existing != nil {
		_ = os.Remove(existing.result)
		_ = os.Remove(existing.analysisResult)
	} else {
		result.Added++
	}
	return j, false, nil
}
