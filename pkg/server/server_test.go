package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"interstellar-proxy/pkg/security"
	"interstellar-proxy/pkg/wisp"
)

func createTestServer() *Server {
	mockFS := fstest.MapFS{
		"index.html": &fstest.MapFile{
			Data: []byte("<html><body>Home</body></html>"),
		},
		"apps.html": &fstest.MapFile{
			Data: []byte("<html><body>Apps</body></html>"),
		},
		"games.html": &fstest.MapFile{
			Data: []byte("<html><body>Games</body></html>"),
		},
		"tabs.html": &fstest.MapFile{
			Data: []byte("<html><body>Tabs</body></html>"),
		},
		"settings.html": &fstest.MapFile{
			Data: []byte("<html><body>Settings</body></html>"),
		},
		"404.html": &fstest.MapFile{
			Data: []byte("<html><body>Custom 404</body></html>"),
		},
		"queue.js": &fstest.MapFile{
			Data: []byte("// Service Worker"),
		},
		"calc/index.js": &fstest.MapFile{
			Data: []byte("console.log('uv client');"),
		},
		"spending/decoder.wasm": &fstest.MapFile{
			Data: []byte("\x00asm\x01\x00\x00\x00"),
		},
		".runtime/vendor-map.cjs": &fstest.MapFile{
			Data: []byte("secret"),
		},
	}

	wispServer := wisp.NewServer(wisp.Config{})
	srv, _ := NewServer(Config{
		Assets:      mockFS,
		WispServer:  wispServer,
		RateLimiter: security.NewRateLimiter(500),
	})
	return srv
}

func TestPageRoutes(t *testing.T) {
	srv := createTestServer()

	routes := []struct {
		url          string
		expectedBody string
	}{
		{"/", "Home"},
		{"/index.html", "Home"},
		{"/apps", "Apps"},
		{"/eb76b74", "Apps"},
		{"/games", "Games"},
		{"/a4f138d", "Games"},
		{"/play.html", "Games"},
		{"/tabs", "Tabs"},
		{"/wb8704c", "Tabs"},
		{"/settings", "Settings"},
		{"/f8c62c3", "Settings"},
	}

	for _, rt := range routes {
		req := httptest.NewRequest("GET", rt.url, nil)
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("GET %s got status %d, want 200", rt.url, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), rt.expectedBody) {
			t.Errorf("GET %s body does not contain %s", rt.url, rt.expectedBody)
		}
	}
}

func TestStaticHeaders(t *testing.T) {
	srv := createTestServer()

	// 1. Service Worker JS
	req := httptest.NewRequest("GET", "/queue.js", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /queue.js got %d", rec.Code)
	}
	if swHeader := rec.Header().Get("Service-Worker-Allowed"); swHeader != "/" {
		t.Errorf("expected Service-Worker-Allowed: /, got %q", swHeader)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/javascript") {
		t.Errorf("expected javascript content-type, got %q", ct)
	}

	// 2. WASM
	reqWasm := httptest.NewRequest("GET", "/spending/decoder.wasm", nil)
	recWasm := httptest.NewRecorder()
	srv.ServeHTTP(recWasm, reqWasm)
	if recWasm.Code != http.StatusOK {
		t.Fatalf("GET /spending/decoder.wasm got %d", recWasm.Code)
	}
	if ct := recWasm.Header().Get("Content-Type"); ct != "application/wasm" {
		t.Errorf("expected application/wasm, got %q", ct)
	}

	// 3. Blocked .runtime
	reqRuntime := httptest.NewRequest("GET", "/.runtime/vendor-map.cjs", nil)
	recRuntime := httptest.NewRecorder()
	srv.ServeHTTP(recRuntime, reqRuntime)
	if recRuntime.Code != http.StatusNotFound {
		t.Errorf("expected 404 for .runtime access, got %d", recRuntime.Code)
	}

	// 4. Custom 404 for missing file
	reqMissing := httptest.NewRequest("GET", "/nonexistent.html", nil)
	recMissing := httptest.NewRecorder()
	srv.ServeHTTP(recMissing, reqMissing)
	if recMissing.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", recMissing.Code)
	}
	if !strings.Contains(recMissing.Body.String(), "Custom 404") {
		t.Errorf("expected Custom 404 body, got %q", recMissing.Body.String())
	}
}
