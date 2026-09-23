package security

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// RateLimiter implements a per-IP token bucket rate limiter
type RateLimiter struct {
	mu           sync.Mutex
	rate         float64 // tokens per second
	capacity     float64 // bucket capacity
	clients      map[string]*clientBucket
	lastCleanup  time.Time
	cleanupEvery time.Duration
}

type clientBucket struct {
	tokens     float64
	lastRefill time.Time
}

// NewRateLimiter creates a limiter with capacity tokens and refill rate
func NewRateLimiter(reqPerMin int) *RateLimiter {
	r := float64(reqPerMin) / 60.0
	return &RateLimiter{
		rate:         r,
		capacity:     float64(reqPerMin),
		clients:      make(map[string]*clientBucket),
		lastCleanup:  time.Now(),
		cleanupEvery: 5 * time.Minute,
	}
}

// Allow checks if a request from the given IP is allowed
func (rl *RateLimiter) Allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()

	// Periodic cleanup of stale client buckets (older than 10 minutes)
	if now.Sub(rl.lastCleanup) > rl.cleanupEvery {
		for k, v := range rl.clients {
			if now.Sub(v.lastRefill) > 10*time.Minute {
				delete(rl.clients, k)
			}
		}
		rl.lastCleanup = now
	}

	b, ok := rl.clients[ip]
	if !ok {
		rl.clients[ip] = &clientBucket{
			tokens:     rl.capacity - 1,
			lastRefill: now,
		}
		return true
	}

	// Refill tokens based on elapsed time
	elapsed := now.Sub(b.lastRefill).Seconds()
	b.tokens += elapsed * rl.rate
	if b.tokens > rl.capacity {
		b.tokens = rl.capacity
	}
	b.lastRefill = now

	if b.tokens >= 1.0 {
		b.tokens -= 1.0
		return true
	}

	return false
}

// ExtractIP extracts the client IP, inspecting standard proxy headers safely
func ExtractIP(r *http.Request) string {
	// Look at X-Forwarded-For if available
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if len(parts) > 0 {
			ip := strings.TrimSpace(parts[0])
			if net.ParseIP(ip) != nil {
				return ip
			}
		}
	}
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		if net.ParseIP(xri) != nil {
			return xri
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

// Middleware returns an HTTP middleware that enforces the rate limit
func (rl *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := ExtractIP(r)
		if !rl.Allow(ip) {
			w.Header().Set("Retry-After", "5")
			http.Error(w, "Too many requests. Please slow down.", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}
