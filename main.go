package main

import (
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"time"
)

//go:embed web
var webFiles embed.FS

type viewerHealth struct {
	App     string `json:"app"`
	Version string `json:"version"`
}

// Reusing a different binary would silently open an older viewer after an upgrade.
func canReuseViewer(health viewerHealth) (bool, error) {
	if health.App != "cs2-local-viewer" {
		return false, nil
	}
	if health.Version == appVersion {
		return true, nil
	}
	runningVersion := health.Version
	if runningVersion == "" {
		runningVersion = "未知（未报告版本号）"
	}
	return false, fmt.Errorf("端口已被另一版本的 CS2 Replay 占用：运行版本 %s，当前程序版本 %s。请关闭旧程序后重新启动，或使用 -port 指定其他端口（例如 -port 8766）", runningVersion, appVersion)
}

func main() {
	port := flag.Int("port", 8765, "Local HTTP port")
	open := flag.Bool("open", false, "Open the viewer in the default browser")
	restore := flag.String("restore-session", "", "Restore an explicitly selected local session manifest and parsed caches")
	executable, err := os.Executable()
	if err != nil {
		log.Fatal(err)
	}
	defaultDemoDir, defaultDataDir := installationDirectories(executable)
	demoDir := flag.String("demo-dir", defaultDemoDir, "Directory automatically scanned for local .dem files")
	dataDir := flag.String("data-dir", defaultDataDir, "Persistent parsed demo library directory")
	flag.Parse()
	if *port < 1 || *port > 65535 {
		log.Fatal("invalid port")
	}
	addr := "127.0.0.1:" + strconv.Itoa(*port)
	url := "http://" + addr
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		client := http.Client{Timeout: time.Second}
		if res, e := client.Get(url + "/api/health"); e == nil {
			defer res.Body.Close()
			var health viewerHealth
			if res.StatusCode == http.StatusOK && json.NewDecoder(res.Body).Decode(&health) == nil {
				reuse, versionErr := canReuseViewer(health)
				if versionErr != nil {
					log.Fatal(versionErr)
				}
				if reuse {
					fmt.Printf("CS2 Replay v%s already running: %s\n", appVersion, url)
					if *open {
						openBrowser(url)
					}
					return
				}
			}
		}
		log.Fatalf("Cannot listen on %s: %v. Try -port 8766", addr, err)
	}
	assets, err := fs.Sub(webFiles, "web")
	if err != nil {
		log.Fatal(err)
	}
	a, err := openLibrary(*dataDir, *demoDir, assets)
	if err != nil {
		_ = listener.Close()
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
