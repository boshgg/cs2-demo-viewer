package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"time"
)

//go:embed web
var webFiles embed.FS

type viewerHealth struct {
	App     string `json:"app"`
	Version string `json:"version"`
}

// Reusing a different binary would silently open an older viewer after an upgrade.
func canReuseViewer(health viewerHealth) bool {
	return health.App == "cs2-local-viewer" && health.Version == appVersion
}

func main() {
	port := flag.Int("port", 8765, "Preferred local HTTP port (automatically changes if unavailable)")
	open := flag.Bool("open", false, "Open the viewer in the default browser")
	mcp := flag.Bool("mcp", false, "Run the local MCP server on stdin/stdout")
	viewerURL := flag.String("viewer-url", "", "Viewer address for -mcp (default: discover a running local viewer)")
	restore := flag.String("restore-session", "", "Restore an explicitly selected local session manifest and parsed caches")
	executable, err := os.Executable()
	if err != nil {
		log.Fatal(err)
	}
	defaultDemoDir, defaultDataDir := installationDirectories(executable)
	demoDir := flag.String("demo-dir", defaultDemoDir, "Directory automatically scanned for local .dem files")
	dataDir := flag.String("data-dir", defaultDataDir, "Persistent parsed demo library directory")
	flag.Parse()
	if *mcp {
		if err := runViewerMCP(*viewerURL); err != nil {
			log.Fatal(err)
		}
		return
	}
	if *port < 1 || *port > 65535 {
		log.Fatal("invalid port")
	}
	listener, url, err := listenForViewer(*port)
	if err != nil {
		log.Fatal(err)
	}
	if url != fmt.Sprintf("http://127.0.0.1:%d", *port) {
		fmt.Printf("Preferred port %d is unavailable; using %s\n", *port, url)
	}
	if listener == nil {
		fmt.Printf("CS2 Replay v%s already running: %s\n", appVersion, url)
		if *open {
			openBrowser(url)
		}
		return
	}
	defer listener.Close()
	assets, err := fs.Sub(webFiles, "web")
	if err != nil {
		log.Fatal(err)
	}
	a, err := openLibrary(*dataDir, *demoDir, assets)
	if err != nil {
		_ = listener.Close()
		// An earlier port may have become free since this viewer started on a
		// fallback port. Recover that instance before reporting the library lock.
		if errors.Is(err, errLibraryLocked) {
			if runningURL := findRunningViewer(*port); runningURL != "" {
				fmt.Printf("CS2 Replay v%s already running: %s\n", appVersion, runningURL)
				if *open {
					openBrowser(runningURL)
				}
				return
			}
		}
		log.Fatalf("Cannot open local library: %v", err)
	}
	defer a.close()
	if *restore != "" {
		if err := a.restoreSession(*restore); err != nil {
			_ = listener.Close()
			a.close()
			log.Fatalf("Cannot restore session: %v", err)
		}
		fmt.Printf("Restored %d analysed demos from the selected local session.\n", len(a.jobs))
	}
	if err := a.persistLibrary(); err != nil {
		a.close()
		_ = listener.Close()
		log.Fatal(err)
	}
	a.startLibraryScan()
	server := &http.Server{Handler: a.handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20}
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt)
	defer signal.Stop(done)
	shutdownDone := make(chan struct{})
	go func() {
		<-done
		a.cancel()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if server.Shutdown(ctx) != nil {
			_ = server.Close()
		}
		close(shutdownDone)
	}()
	fmt.Printf("\nCS2 2D Demo Viewer v%s\n%s\n\nDemo directory: %s\nPersistent data: %s\nFiles stay on this computer. Press Ctrl+C to stop.\n\n", appVersion, url, a.demoDir, a.root)
	if *open {
		openBrowser(url)
	}
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Print(err)
		return
	}
	<-shutdownDone
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("Open %s manually: %v", url, err)
	} else {
		go cmd.Wait()
	}
}
