package server

import (
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"

	"interstellar-proxy/pkg/security"
	"interstellar-proxy/pkg/wisp"
)

var ghGamesBases = map[string]string{
	"/gh-games/1/": "https://raw.githubusercontent.com/qrs/x/fixy/",
	"/gh-games/2/": "https://raw.githubusercontent.com/3v1/V5-Assets/main/",
	"/gh-games/3/": "https://raw.githubusercontent.com/3v1/V5-Retro/master/",
	"/gh-games/4/": "https://raw.githubusercontent.com/xbubbo/V6-Assets/main/",
}

// Config stores HTTP server configuration
type Config struct {
	Assets      fs.FS
	WispServer  *wisp.Server
	Auth        *security.AuthConfig
	RateLimiter *security.RateLimiter
}

// Server serves Interstellar frontend assets, routes, games proxy, and Wisp
type Server struct {
	assets      fs.FS
	wispServer  *wisp.Server
	auth        *security.AuthConfig
	rateLimiter *security.RateLimiter
	httpClient  *http.Client
	pageRoutes  map[string]string
	notFoundDoc []byte
}

// NewServer initializes the HTTP handler with embedded assets and security
func NewServer(cfg Config) (*Server, error) {
	if cfg.RateLimiter == nil {
		cfg.RateLimiter = security.NewRateLimiter(120) // 120 req/min
	}

	pageRoutes := map[string]string{
		"/":          "index.html",
		"/index.html": "index.html",
		"/apps":      "apps.html",
		"/eb76b74":   "apps.html",
		"/games":     "games.html",
		"/a4f138d":   "games.html",
		"/play.html":  "games.html",
		"/tabs":      "tabs.html",
		"/wb8704c":   "tabs.html",
		"/settings":  "settings.html",
		"/f8c62c3":   "settings.html",
	}

	var notFoundDoc []byte
	if cfg.Assets != nil {
		if data, err := fs.ReadFile(cfg.Assets, "404.html"); err == nil {
			notFoundDoc = data
		}
	}
	if len(notFoundDoc) == 0 {
		notFoundDoc = []byte("<!DOCTYPE html><html><head><title>404 Not Found</title></head><body><h1>404 Not Found</h1></body></html>")
	}

	return &Server{
		assets:      cfg.Assets,
		wispServer:  cfg.WispServer,
		auth:        cfg.Auth,
		rateLimiter: cfg.RateLimiter,
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
		pageRoutes:  pageRoutes,
		notFoundDoc: notFoundDoc,
	}, nil
}

// ServeHTTP handles incoming HTTP requests
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// 1. Rate limiting check
	clientIP := security.ExtractIP(r)
	if !s.rateLimiter.Allow(clientIP) {
		w.Header().Set("Retry-After", "5")
		http.Error(w, "Too many requests. Please slow down.", http.StatusTooManyRequests)
		return
	}

	// 2. Authentication check (if enabled)
	if s.auth != nil && s.auth.Enabled {
		user, pass, ok := r.BasicAuth()
		if !ok || !s.auth.CheckCredentials(user, pass) {
			w.Header().Set("WWW-Authenticate", `Basic realm="Interstellar Secure Proxy"`)
			http.Error(w, "Unauthorized. Authentication required to access this proxy.", http.StatusUnauthorized)
			return
		}
	}

	// 3. Security headers
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")

	// 4. Handle Wisp WebSocket endpoint (/wisp/, /wisp) or WebSocket upgrade on /
	reqPath := r.URL.Path
	if strings.HasPrefix(reqPath, "/wisp") || (reqPath == "/" && strings.ToLower(r.Header.Get("Upgrade")) == "websocket") {
		if s.wispServer != nil {
			s.wispServer.ServeHTTP(w, r)
			return
		}
		http.Error(w, "Wisp proxy not configured", http.StatusBadGateway)
		return
	}

	// 5. Clean path and block directory traversal & hidden files (like /.runtime)
	cleanPath := path.Clean(reqPath)
	if cleanPath == "/.runtime" || strings.HasPrefix(cleanPath, "/.runtime/") || strings.Contains(cleanPath, "/.") {
		s.serveNotFound(w, r)
		return
	}

	// 6. Handle GitHub Games Asset proxy (/gh-games/...)
	if strings.HasPrefix(cleanPath, "/gh-games/") {
		s.handleGhGames(w, r, cleanPath)
		return
	}

	// 7. Handle analytics loader stub (/3/decoder/profiler.js)
	if cleanPath == "/3/decoder/profiler.js" {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("// Analytics stub - privacy protected\n"))
		return
	}

	// 8. Handle page routes (/apps, /games, /tabs, /settings, /)
	if targetFile, exists := s.pageRoutes[cleanPath]; exists {
		s.serveAssetFile(w, r, targetFile)
		return
	}

	// 9. Handle static assets in dist/
	assetFile := strings.TrimPrefix(cleanPath, "/")
	s.serveAssetFile(w, r, assetFile)
}

func (s *Server) serveAssetFile(w http.ResponseWriter, r *http.Request, filename string) {
	if s.assets == nil {
		s.serveNotFound(w, r)
		return
	}

	// Check if file exists in assets
	data, err := fs.ReadFile(s.assets, filename)
	if err != nil {
		// If requesting a directory or not found, serve 404
		s.serveNotFound(w, r)
		return
	}

	// Determine content type
	ext := strings.ToLower(path.Ext(filename))
	contentType := ""
	switch ext {
	case ".js", ".mjs":
		contentType = "text/javascript; charset=utf-8"
		w.Header().Set("Service-Worker-Allowed", "/")
	case ".wasm":
		contentType = "application/wasm"
	case ".css":
		contentType = "text/css; charset=utf-8"
	case ".html":
		contentType = "text/html; charset=utf-8"
	case ".json":
		contentType = "application/json; charset=utf-8"
	case ".png":
		contentType = "image/png"
	case ".jpg", ".jpeg":
		contentType = "image/jpeg"
	case ".svg":
		contentType = "image/svg+xml"
	case ".ico":
		contentType = "image/x-icon"
	case ".woff2":
		contentType = "font/woff2"
	case ".txt":
		contentType = "text/plain; charset=utf-8"
	default:
		contentType = mime.TypeByExtension(ext)
		if contentType == "" {
			contentType = "application/octet-stream"
		}
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) serveNotFound(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write(s.notFoundDoc)
}

func (s *Server) handleGhGames(w http.ResponseWriter, r *http.Request, cleanPath string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	var upstreamURL string
	for prefix, base := range ghGamesBases {
		if strings.HasPrefix(cleanPath, prefix) {
			relPath := strings.TrimPrefix(cleanPath, prefix)
			// Prevent directory traversal
			relPath = path.Clean("/" + relPath)
			upstreamURL = base + strings.TrimPrefix(relPath, "/")
			break
		}
	}

	if upstreamURL == "" {
		s.serveNotFound(w, r)
		return
	}

	upstreamReq, err := http.NewRequestWithContext(r.Context(), r.Method, upstreamURL, nil)
	if err != nil {
		s.serveNotFound(w, r)
		return
	}

	if ifNoneMatch := r.Header.Get("If-None-Match"); ifNoneMatch != "" {
		upstreamReq.Header.Set("If-None-Match", ifNoneMatch)
	}

	resp, err := s.httpClient.Do(upstreamReq)
	if err != nil {
		log.Printf("[GH-GAMES] Error fetching %s: %v", upstreamURL, err)
		http.Error(w, "Error fetching game asset", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotModified {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	if resp.StatusCode != http.StatusOK {
		s.serveNotFound(w, r)
		return
	}

	ext := strings.ToLower(path.Ext(cleanPath))
	contentType := mime.TypeByExtension(ext)
	if ext == ".unityweb" || contentType == "" {
		contentType = "application/octet-stream"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	if etag := resp.Header.Get("ETag"); etag != "" {
		w.Header().Set("ETag", etag)
	}
	if lastMod := resp.Header.Get("Last-Modified"); lastMod != "" {
		w.Header().Set("Last-Modified", lastMod)
	}

	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, resp.Body)
	}
}
