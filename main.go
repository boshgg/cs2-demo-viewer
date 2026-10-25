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

func main() {
	port := flag.Int("port", 8765, "Local HTTP port")
	open := flag.Bool("open", false, "Open the viewer in the default browser")
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
			var health struct {
				App string `json:"app"`
			}
			_ = json.NewDecoder(res.Body).Decode(&health)
			if health.App == "cs2-local-viewer" {
				fmt.Println("Viewer already running:", url)
				if *open {
					openBrowser(url)
				}
				return
			}
		}
		log.Fatalf("Cannot listen on %s: %v. Try -port 8766", addr, err)
	}
	root, err := os.MkdirTemp("", "cs2-local-viewer-")
	if err != nil {
		log.Fatal(err)
	}
	assets, err := fs.Sub(webFiles, "web")
	if err != nil {
		log.Fatal(err)
	}
	a := newApp(root, assets)
	defer a.close()
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
	fmt.Printf("\nCS2 2D Demo Viewer\n%s\n\nImport a .dem file in your browser. Files stay on this computer.\nPress Ctrl+C to stop.\nCache: %s\n\n", url, root)
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
