package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"
)

const viewerPortAttempts = 20

func viewerProbeClient() *http.Client {
	return &http.Client{
		Timeout: 250 * time.Millisecond,
		// Probe only the selected local service, without proxies or redirects.
		Transport: &http.Transport{DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// listenForViewer keeps the selected socket open so another process cannot take
// the port between selection and Serve. A nil listener means a matching viewer
// is already serving the returned URL.
func listenForViewer(preferredPort int) (net.Listener, string, error) {
	if preferredPort < 1 || preferredPort > 65535 {
		return nil, "", fmt.Errorf("invalid port: %d (expected 1-65535)", preferredPort)
	}
	client := viewerProbeClient()
	for port := preferredPort; port < preferredPort+viewerPortAttempts && port <= 65535; port++ {
		addr := "127.0.0.1:" + strconv.Itoa(port)
		listener, err := net.Listen("tcp4", addr)
		if err == nil {
			return listener, "http://" + listener.Addr().String(), nil
		}
		url := "http://" + addr
		if isRunningViewer(client, url) {
			return nil, url, nil
		}
	}
	// Avoid scanning thousands of ports if a whole range is reserved or busy.
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, "", fmt.Errorf("cannot listen on a local port (preferred %d): %w", preferredPort, err)
	}
	return listener, "http://" + listener.Addr().String(), nil
}

// Used only after a library lock conflict; normal startup stops at the first
// free port. Check the whole candidate range even if an earlier port is free.
func findRunningViewer(preferredPort int) string {
	client := viewerProbeClient()
	for port := preferredPort; port < preferredPort+viewerPortAttempts && port <= 65535; port++ {
		url := "http://127.0.0.1:" + strconv.Itoa(port)
		if isRunningViewer(client, url) {
			return url
		}
	}
	return ""
}

func isRunningViewer(client *http.Client, url string) bool {
	res, err := client.Get(url + "/api/health")
	if err != nil {
		return false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return false
	}
	var health viewerHealth
	return json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&health) == nil && canReuseViewer(health)
}
