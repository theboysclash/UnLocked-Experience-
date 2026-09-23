package security

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRateLimiter(t *testing.T) {
	limiter := NewRateLimiter(60) // 60 req/min = 1 req/sec, capacity 60
	ip := "192.0.2.1"

	for i := 0; i < 60; i++ {
		if !limiter.Allow(ip) {
			t.Fatalf("request %d should have been allowed", i)
		}
	}

	// 61st request should be rejected
	if limiter.Allow(ip) {
		t.Fatal("request 61 should have been rate-limited")
	}
}

func TestAuthMiddleware(t *testing.T) {
	auth := &AuthConfig{
		Enabled:  true,
		Password: "supersecretpassword",
	}

	handler := auth.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	}))

	// Unauthorized request
	req1 := httptest.NewRequest("GET", "/", nil)
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec1.Code)
	}

	// Authorized request
	req2 := httptest.NewRequest("GET", "/", nil)
	req2.SetBasicAuth("admin", "supersecretpassword")
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec2.Code)
	}
}
