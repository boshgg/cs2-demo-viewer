package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

// The executable and its demo library can be replaced independently of the
// current user's credentials. The viewer port is not part of this directory.
func insightsCredentialDirectory() (string, error) {
	root, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "cs2-demo-viewer", "credentials"), nil
}

// The wrapper in app.handler already rejects foreign Hosts and Origins. For
// stored secrets additionally require a same-origin browser POST on loopback.
func localCredentialRequest(r *http.Request) bool {
	peer, _, err := net.SplitHostPort(r.RemoteAddr)
	return err == nil && net.ParseIP(peer).IsLoopback() &&
		r.Header.Get("Origin") == "http://"+r.Host &&
		(r.Header.Get("Sec-Fetch-Site") == "" || r.Header.Get("Sec-Fetch-Site") == "same-origin")
}

func credentialScope(provider string, endpoint *url.URL) (string, error) {
	u := *endpoint
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if port != "" && !(u.Scheme == "https" && port == "443") && !(u.Scheme == "http" && port == "80") {
		u.Host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	} else {
		u.Host = host
	}
	destination := u.String()
	switch provider {
	case "custom":
	case "glm":
		if destination != "https://open.bigmodel.cn/api/paas/v4/chat/completions" {
			return "", errors.New("智谱 GLM 的密钥只能用于所选预设服务")
		}
	case "deepseek":
		if destination != "https://api.deepseek.com/chat/completions" {
			return "", errors.New("DeepSeek 的密钥只能用于所选预设服务")
		}
	default:
		return "", errors.New("请选择有效的模型厂商")
	}
	hash := sha256.Sum256([]byte(provider + "\n" + destination))
	return hex.EncodeToString(hash[:]), nil
}

func credentialFile(scope string) (string, error) {
	dir, err := insightsCredentialDirectory()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, scope+".key"), nil
}

func saveInsightsCredential(path, scope, key string) error {
	data, err := sealInsightsCredential([]byte(key), scope)
	if err != nil {
		return err
	}
	defer clear(data)
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".saving-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}

func readInsightsCredential(scope string) (string, error) {
	path, err := credentialFile(scope)
	if err != nil {
		return "", err
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, (64<<10)+1))
	if err != nil || len(data) == 0 || len(data) > 64<<10 {
		return "", errors.New("invalid stored credential")
	}
	defer clear(data)
	plain, err := openInsightsCredential(data, scope)
	if err != nil {
		return "", err
	}
	defer clear(plain)
	key := string(plain)
	if !validInsightsCredential(key) {
		return "", errors.New("invalid stored credential")
	}
	return key, nil
}

func validInsightsCredential(key string) bool {
	return len(key) > 0 && len(key) <= 8192 && strings.TrimSpace(key) == key && strings.IndexFunc(key, unicode.IsControl) == -1
}

func insightsCredential(w http.ResponseWriter, r *http.Request) {
	if !localCredentialRequest(r) {
		apiError(w, 403, "请从本机查看器页面管理密钥")
		return
	}
	contentType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if contentType != "application/json" {
		apiError(w, 415, "请使用 application/json")
		return
	}
	var input struct {
		Action   string `json:"action"`
		Provider string `json:"provider"`
		BaseURL  string `json:"baseUrl"`
		APIKey   string `json:"apiKey"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		apiError(w, 400, "密钥请求格式无效")
		return
	}
	endpoint, err := (insightsConnection{BaseURL: input.BaseURL, Model: "credential"}).endpoint()
	if err != nil {
		apiError(w, 400, err.Error())
		return
	}
	scope, err := credentialScope(input.Provider, endpoint)
	if err != nil {
		apiError(w, 400, err.Error())
		return
	}
	path, err := credentialFile(scope)
	if err != nil {
		apiError(w, 500, "无法访问当前用户的密钥存储")
		return
	}
	var saved bool
	switch input.Action {
	case "status":
		_, err = os.Stat(path)
		saved = err == nil
	case "delete":
		err = os.Remove(path)
	case "save":
		if !validInsightsCredential(input.APIKey) {
			apiError(w, 400, "请输入有效的 API 密钥")
			return
		}
		err = saveInsightsCredential(path, scope, input.APIKey)
		saved = err == nil
	default:
		apiError(w, 400, "未知密钥操作")
		return
	}
	if err != nil && !(input.Action != "save" && errors.Is(err, os.ErrNotExist)) {
		apiError(w, 500, "无法访问当前用户的密钥存储")
		return
	}
	jsonResponse(w, 200, map[string]bool{"saved": saved})
}
