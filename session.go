package main

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// sessionManifest refers only to fixed cache names beside this manifest. It is
// an explicit local snapshot, never a request to scan another instance's cache.
type sessionManifest struct {
	Version  int             `json:"version"`
	ID       string          `json:"id"`
	Demos    []sessionDemo   `json:"demos"`
	Settings json.RawMessage `json:"settings"`
}

type sessionDemo struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Map            string `json:"map"`
	ReplaySHA256   string `json:"replaySHA256"`
	AnalysisSHA256 string `json:"analysisSHA256"`
	SourceFile     string `json:"sourceFile,omitempty"`
	SourceSize     int64  `json:"sourceSize,omitempty"`
	SourceModTime  int64  `json:"sourceModTime,omitempty"`
	SourceSHA256   string `json:"sourceSHA256,omitempty"`
}

func validSessionID(id string) bool {
	if len(id) != 24 || id != strings.ToLower(id) {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

func validSessionHash(hash string) bool {
	if len(hash) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(hash)
	return err == nil
}

func (a *app) restoreSession(manifestPath string) (err error) {
	absolute, err := filepath.Abs(manifestPath)
	if err != nil {
		return err
	}
	absolute, err = filepath.EvalSymlinks(absolute)
	if err != nil {
		return err
	}
	file, err := os.Open(absolute)
	if err != nil {
		return err
	}
	var manifest sessionManifest
	decoder := json.NewDecoder(io.LimitReader(file, (1<<20)+1))
	decoder.DisallowUnknownFields()
	err = decoder.Decode(&manifest)
	if err == nil {
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			err = fmt.Errorf("session manifest must contain one JSON object")
		}
	}
	_ = file.Close()
	if err != nil {
		return fmt.Errorf("invalid session manifest: %w", err)
	}
	if manifest.Version != 1 || manifest.ID == "" || len(manifest.ID) > 128 || len(manifest.Demos) == 0 {
		return fmt.Errorf("unsupported or incomplete session manifest")
	}
	a.mu.Lock()
	alreadyRestored, empty := a.sessionID == manifest.ID, len(a.jobs) == 0
	a.mu.Unlock()
	if alreadyRestored {
		return nil
	}
	if !empty {
		return fmt.Errorf("session restore requires a new empty library")
	}
	if len(manifest.Settings) > 256<<10 || (len(manifest.Settings) > 0 && string(manifest.Settings) != "null" && manifest.Settings[0] != '{') {
		return fmt.Errorf("session settings must be an object of at most 256 KiB")
	}
	seen := map[string]bool{}
	sources := map[string]string{}
	for _, demo := range manifest.Demos {
		if !validSessionID(demo.ID) || seen[demo.ID] || demo.Name == "" || demo.Map == "" || !validSessionHash(demo.ReplaySHA256) || !validSessionHash(demo.AnalysisSHA256) {
			return fmt.Errorf("invalid or duplicate session demo metadata")
		}
		seen[demo.ID] = true
		if demo.SourceSize > 0 || demo.SourceFile != "" || demo.SourceModTime != 0 {
			name := demo.SourceFile
			if name == "" {
				name = demo.Name
			}
			if a.demoDir == "" || name != filepath.Base(name) || strings.ContainsAny(name, "/\\") || !strings.EqualFold(filepath.Ext(name), ".dem") {
				return fmt.Errorf("invalid source binding")
			}
			path := filepath.Join(a.demoDir, name)
			info, e := os.Lstat(path)
			if e != nil || !info.Mode().IsRegular() || info.Size() != demo.SourceSize || info.ModTime().UnixNano() != demo.SourceModTime {
				return fmt.Errorf("bound source identity changed: %s", name)
			}
			if demo.SourceSHA256 != "" {
				if !validSessionHash(demo.SourceSHA256) {
					return fmt.Errorf("invalid source digest")
				}
				f, e := os.Open(path)
				if e != nil {
					return e
				}
				h := sha256.New()
				_, e = io.Copy(h, f)
				f.Close()
				if e != nil || !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), demo.SourceSHA256) {
					return fmt.Errorf("bound source digest changed: %s", name)
				}
			}
			sources[demo.ID] = path
		}
	}
	// All copies and validations finish before any job becomes observable. On a
	// failure, only files created by this restore attempt are removed.
	created := []string{}
	defer func() {
		if err != nil {
			for _, path := range created {
				_ = os.Remove(path)
			}
		}
	}()
	base := filepath.Dir(absolute)
	for _, demo := range manifest.Demos {
		for _, item := range []struct{ suffix, hash string }{{".json.gz", demo.ReplaySHA256}, {".analysis.json.gz", demo.AnalysisSHA256}} {
			source := filepath.Join(base, demo.ID+item.suffix)
			destination := filepath.Join(a.root, demo.ID+item.suffix)
			if err = copySessionCache(source, destination, item.hash); err != nil {
				return fmt.Errorf("restore %s: %w", demo.ID, err)
			}
			created = append(created, destination)
			if err = validateSessionCache(destination, demo); err != nil {
				return fmt.Errorf("restore %s: %w", demo.ID, err)
			}
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.jobs) != 0 {
		return fmt.Errorf("viewer changed while restoring the session")
	}
	started := time.Now()
	for index, demo := range manifest.Demos {
		ctx, cancel := context.WithCancel(a.ctx)
		a.jobs[demo.ID] = &job{ID: demo.ID, Revision: demo.ID, Name: demo.Name, name: demo.Name, Map: demo.Map, Analysis: true, Status: "ready", Progress: 1, Message: "已恢复解析结果", source: sources[demo.ID], sourceSize: demo.SourceSize, sourceModTime: demo.SourceModTime, result: filepath.Join(a.root, demo.ID+".json.gz"), analysisResult: filepath.Join(a.root, demo.ID+".analysis.json.gz"), created: started.Add(time.Duration(index)), ctx: ctx, cancel: cancel}
	}
	a.sessionID = manifest.ID
	a.sessionSettings = append(json.RawMessage(nil), manifest.Settings...)
	return nil
}

func copySessionCache(source, destination, expectedHash string) (err error) {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > maxUploadBytes {
		return fmt.Errorf("cache is not a regular nonempty file within the size limit")
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := output.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			_ = os.Remove(destination)
		}
	}()
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(output, hash), io.LimitReader(input, maxUploadBytes+1))
	if err != nil {
		return err
	}
	if written > maxUploadBytes || !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), expectedHash) {
		return fmt.Errorf("cache SHA-256 verification failed")
	}
	return nil
}

func validateSessionCache(path string, demo sessionDemo) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer gz.Close()
	// Decode the entire JSON and consume EOF to verify the gzip trailer/checksum,
	// without rebuilding gameplay data or running the demo parser again.
	decoder := json.NewDecoder(io.LimitReader(gz, maxUploadBytes+1))
	var identity struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Map  string `json:"map"`
	}
	if err := decoder.Decode(&identity); err != nil {
		return fmt.Errorf("invalid compressed JSON: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("cache must contain one complete JSON object: %v", err)
	}
	if identity.ID != demo.ID || identity.Name != demo.Name || identity.Map != demo.Map {
		return fmt.Errorf("cache identity does not match the session manifest")
	}
	return nil
}

func (a *app) sessionSettingsResult(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	id, settings := a.sessionID, append(json.RawMessage(nil), a.sessionSettings...)
	a.mu.Unlock()
	jsonResponse(w, http.StatusOK, map[string]any{"sessionId": id, "settings": settings})
}
