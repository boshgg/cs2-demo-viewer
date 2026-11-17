package main

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
)

// Reserve the whole range before a test starts; never depend on a user's 8765
// service or assume that adjacent ephemeral ports happen to be free.
func reserveViewerTestPorts(t *testing.T, count int) ([]net.Listener, int) {
	t.Helper()
	for attempt := 0; attempt < 100; attempt++ {
		first, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		base := first.Addr().(*net.TCPAddr).Port
		listeners := []net.Listener{first}
		if base+count-1 <= 65535 {
			for offset := 1; offset < count; offset++ {
				listener, err := net.Listen("tcp4", "127.0.0.1:"+strconv.Itoa(base+offset))
				if err != nil {
					break
				}
				listeners = append(listeners, listener)
			}
		}
		if len(listeners) == count {
			t.Cleanup(func() {
				for _, listener := range listeners {
					_ = listener.Close()
				}
			})
			return listeners, base
		}
		for _, listener := range listeners {
			_ = listener.Close()
		}
	}
	t.Fatalf("could not reserve %d consecutive loopback ports", count)
	return nil, 0
}

func serveViewerTestPort(t *testing.T, listener net.Listener, handler http.Handler) {
	t.Helper()
	server := &http.Server{Handler: handler}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
}

func viewerTestHealth(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/health" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"app":"cs2-local-viewer","version":%q}`, appVersion)
}

func requireViewerTestListener(t *testing.T, listener net.Listener, url string, err error) int {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	if listener == nil {
		t.Fatalf("expected a new listener, got reused URL %q", url)
	}
	t.Cleanup(func() { _ = listener.Close() })
	addr := listener.Addr().(*net.TCPAddr)
	if !addr.IP.Equal(net.IPv4(127, 0, 0, 1)) || addr.Port == 0 {
		t.Fatalf("listener is not on a concrete IPv4 loopback port: %s", addr)
	}
	if want := "http://" + addr.String(); url != want {
		t.Fatalf("URL %q does not match actual listener %q", url, want)
	}
	return addr.Port
}

func TestListenForViewerReservesAvailablePort(t *testing.T) {
	reserved, port := reserveViewerTestPorts(t, 1)
	_ = reserved[0].Close()
	listener, url, err := listenForViewer(port)
	if got := requireViewerTestListener(t, listener, url, err); got != port {
		t.Fatalf("selected port %d, want preferred port %d", got, port)
	}
	duplicate, err := net.Listen("tcp4", listener.Addr().String())
	if err == nil {
		_ = duplicate.Close()
		t.Fatal("selected port was not kept reserved for the viewer")
	}
}

func TestListenForViewerSkipsConsecutiveOccupiedPorts(t *testing.T) {
	reserved, port := reserveViewerTestPorts(t, 3)
	serveViewerTestPort(t, reserved[0], http.NotFoundHandler())
	serveViewerTestPort(t, reserved[1], http.NotFoundHandler())
	_ = reserved[2].Close()
	listener, url, err := listenForViewer(port)
	if got := requireViewerTestListener(t, listener, url, err); got != port+2 {
		t.Fatalf("selected port %d, want first available port %d", got, port+2)
	}
}

func TestListenForViewerSkipsUnresponsivePort(t *testing.T) {
	reserved, port := reserveViewerTestPorts(t, 2)
	// Keep the first socket open without serving HTTP. The health timeout must
	// let startup proceed even when another local application never responds.
	_ = reserved[1].Close()
	listener, url, err := listenForViewer(port)
	if got := requireViewerTestListener(t, listener, url, err); got != port+1 {
		t.Fatalf("selected port %d, want %d after unresponsive service", got, port+1)
	}
}

func TestListenForViewerReusesMatchingVersion(t *testing.T) {
	for _, offset := range []int{0, 1} {
		t.Run(fmt.Sprintf("offset_%d", offset), func(t *testing.T) {
			reserved, port := reserveViewerTestPorts(t, offset+1)
			for _, listener := range reserved[:offset] {
				serveViewerTestPort(t, listener, http.NotFoundHandler())
			}
			serveViewerTestPort(t, reserved[offset], http.HandlerFunc(viewerTestHealth))
			listener, url, err := listenForViewer(port)
			if listener != nil {
				_ = listener.Close()
				t.Fatal("started a second listener instead of reusing the matching viewer")
			}
			if want := fmt.Sprintf("http://127.0.0.1:%d", port+offset); err != nil || url != want {
				t.Fatalf("reuse = (%q, %v), want (%q, nil)", url, err, want)
			}
		})
	}
}

func TestListenForViewerRejectsIncompatibleHealth(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
	}{
		{"older viewer", http.StatusOK, `{"app":"cs2-local-viewer","version":"3.1.0"}`},
		{"missing version", http.StatusOK, `{"app":"cs2-local-viewer"}`},
		{"different application", http.StatusOK, fmt.Sprintf(`{"app":"other-service","version":%q}`, appVersion)},
		{"invalid response", http.StatusOK, `<html>Another local service</html>`},
		{"unhealthy viewer", http.StatusServiceUnavailable, fmt.Sprintf(`{"app":"cs2-local-viewer","version":%q}`, appVersion)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reserved, port := reserveViewerTestPorts(t, 2)
			serveViewerTestPort(t, reserved[0], http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tt.status)
				_, _ = fmt.Fprint(w, tt.body)
			}))
			_ = reserved[1].Close()
			listener, url, err := listenForViewer(port)
			if got := requireViewerTestListener(t, listener, url, err); got != port+1 {
				t.Fatalf("selected port %d, want %d after incompatible service", got, port+1)
			}
		})
	}
}

func TestListenForViewerDoesNotFollowHealthRedirect(t *testing.T) {
	var redirectedRequests atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirectedRequests.Add(1)
		viewerTestHealth(w, r)
	}))
	t.Cleanup(target.Close)
	reserved, port := reserveViewerTestPorts(t, 2)
	serveViewerTestPort(t, reserved[0], http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/api/health", http.StatusFound)
	}))
	_ = reserved[1].Close()
	listener, url, err := listenForViewer(port)
	if got := requireViewerTestListener(t, listener, url, err); got != port+1 {
		t.Fatalf("selected port %d, want %d after redirecting service", got, port+1)
	}
	if count := redirectedRequests.Load(); count != 0 {
		t.Fatalf("followed untrusted local health redirect %d times", count)
	}
}

func TestListenForViewerUsesSystemPortAfterBusyRange(t *testing.T) {
	reserved, port := reserveViewerTestPorts(t, viewerPortAttempts)
	for _, listener := range reserved {
		serveViewerTestPort(t, listener, http.NotFoundHandler())
	}
	listener, url, err := listenForViewer(port)
	got := requireViewerTestListener(t, listener, url, err)
	if got >= port && got < port+viewerPortAttempts {
		t.Fatalf("selected occupied port %d in %d..%d", got, port, port+viewerPortAttempts-1)
	}
}

func TestListenForViewerHandlesLastPort(t *testing.T) {
	occupied, err := net.Listen("tcp4", "127.0.0.1:65535")
	if err != nil {
		t.Skipf("cannot reserve boundary port 65535: %v", err)
	}
	t.Cleanup(func() { _ = occupied.Close() })
	serveViewerTestPort(t, occupied, http.NotFoundHandler())
	listener, url, err := listenForViewer(65535)
	if got := requireViewerTestListener(t, listener, url, err); got == 65535 {
		t.Fatal("selected the occupied boundary port")
	}
}

func TestListenForViewerRejectsInvalidPorts(t *testing.T) {
	for _, port := range []int{-1, 0, 65536} {
		t.Run(strconv.Itoa(port), func(t *testing.T) {
			listener, url, err := listenForViewer(port)
			if listener != nil {
				_ = listener.Close()
			}
			if err == nil || listener != nil || url != "" {
				t.Fatalf("invalid port %d returned (%v, %q, %v)", port, listener, url, err)
			}
		})
	}
}

func TestFindRunningViewerAfterPreferredPortBecomesFree(t *testing.T) {
	reserved, port := reserveViewerTestPorts(t, 2)
	serveViewerTestPort(t, reserved[1], http.HandlerFunc(viewerTestHealth))
	// The unrelated service that originally forced the viewer to port+1 exits.
	// A second launch must still find that viewer when the library is locked.
	_ = reserved[0].Close()
	if got, want := findRunningViewer(port), fmt.Sprintf("http://127.0.0.1:%d", port+1); got != want {
		t.Fatalf("found viewer %q, want existing fallback viewer %q", got, want)
	}
}
