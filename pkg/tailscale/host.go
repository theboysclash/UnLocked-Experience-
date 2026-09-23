package tailscale

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

// Config holds the configuration options for the Tailscale embedded node
type Config struct {
	Hostname     string
	StateDir     string
	AuthKey      string
	Ephemeral    bool
	EnableFunnel bool
	VerboseLogs  bool
}

// Host encapsulates an embedded tsnet.Server running Interstellar
type Host struct {
	cfg       Config
	tsServer  *tsnet.Server
	listener  net.Listener
	publicURL string
	mu        sync.RWMutex
	closed    bool
}

// DefaultStateDir returns an OS-appropriate state directory for Tailscale
func DefaultStateDir() string {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return filepath.Join(".", ".tailscale-state")
	}
	return filepath.Join(configDir, "InterstellarProxy")
}

// NewHost creates a new Tailscale Host with tsnet
func NewHost(cfg Config) (*Host, error) {
	if cfg.Hostname == "" {
		cfg.Hostname = "interstellar-proxy"
	}
	if cfg.StateDir == "" {
		cfg.StateDir = DefaultStateDir()
	}

	if err := os.MkdirAll(cfg.StateDir, 0700); err != nil {
		return nil, fmt.Errorf("failed to create Tailscale state directory %s: %w", cfg.StateDir, err)
	}

	ts := &tsnet.Server{
		Hostname:  cfg.Hostname,
		Dir:       cfg.StateDir,
		AuthKey:   cfg.AuthKey,
		Ephemeral: cfg.Ephemeral,
		UserLogf: func(format string, args ...any) {
			msg := fmt.Sprintf(format, args...)
			// Filter and display important user messages like login URL
			if strings.Contains(msg, "https://login.tailscale.com") {
				log.Printf("\n===================================================================\n"+
					"👉 ACTION REQUIRED: LOG IN TO TAILSCALE TO HOST PUBLIC PROXY:\n   %s\n"+
					"===================================================================\n", strings.TrimSpace(msg))
			} else if strings.Contains(msg, "backend error") || strings.Contains(msg, "auth failed") {
				log.Printf("[Tailscale Error] %s", msg)
			} else if cfg.VerboseLogs {
				log.Printf("[Tailscale] %s", msg)
			}
		},
	}

	if cfg.VerboseLogs {
		ts.Logf = log.Printf
	}

	return &Host{
		cfg:      cfg,
		tsServer: ts,
	}, nil
}

// Start brings up the Tailscale node and starts serving HTTP over Funnel or TLS
func (h *Host) Start(ctx context.Context, handler http.Handler) error {
	log.Printf("[Tailscale] Starting embedded node '%s' (State dir: %s)...", h.cfg.Hostname, h.cfg.StateDir)

	if err := h.tsServer.Start(); err != nil {
		return fmt.Errorf("failed to start Tailscale node: %w", err)
	}

	// Wait for the Tailscale network status
	log.Printf("[Tailscale] Connecting to Tailscale network...")
	statusCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()

	status, err := h.tsServer.Up(statusCtx)
	if err != nil {
		log.Printf("[Tailscale Notice] Could not immediately verify status (%v). Continuing to listen...", err)
	} else if status != nil && status.Self != nil {
		log.Printf("[Tailscale] Node connected successfully! IP: %s, DNS: %s",
			status.Self.TailscaleIPs, status.Self.DNSName)
	}

	var ln net.Listener
	if h.cfg.EnableFunnel {
		log.Printf("[Tailscale] Enabling Tailscale Funnel on port 443 (Public Internet HTTPS access)...")
		ln, err = h.tsServer.ListenFunnel("tcp", ":443")
		if err != nil {
			log.Printf("[Tailscale Warning] ListenFunnel failed: %v. Falling back to Tailnet TLS...", err)
			ln, err = h.tsServer.ListenTLS("tcp", ":443")
			if err != nil {
				return fmt.Errorf("failed to listen on Tailscale TLS port 443: %w", err)
			}
		}
	} else {
		log.Printf("[Tailscale] Funnel disabled. Listening on Tailnet TLS port 443...")
		ln, err = h.tsServer.ListenTLS("tcp", ":443")
		if err != nil {
			return fmt.Errorf("failed to listen on Tailscale TLS port 443: %w", err)
		}
	}

	h.mu.Lock()
	h.listener = ln
	domains := h.tsServer.CertDomains()
	if len(domains) > 0 {
		h.publicURL = fmt.Sprintf("https://%s/", domains[0])
	}
	h.mu.Unlock()

	if h.publicURL != "" {
		log.Printf("\n"+
			"╔══════════════════════════════════════════════════════════════════════════╗\n"+
			"║  🌐 PUBLIC PROXY URL (Accessible from ANY Wi-Fi or device):              ║\n"+
			"║     %-68s ║\n"+
			"╚══════════════════════════════════════════════════════════════════════════╝\n",
			h.publicURL)
	} else {
		log.Printf("[Tailscale] Proxy listening on port 443.")
	}

	go func() {
		server := &http.Server{
			Handler:           handler,
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       120 * time.Second,
		}
		if serveErr := server.Serve(ln); serveErr != nil && serveErr != http.ErrServerClosed {
			log.Printf("[Tailscale Server] Serve error: %v", serveErr)
		}
	}()

	return nil
}

// GetPublicURL returns the public Tailscale HTTPS URL
func (h *Host) GetPublicURL() string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.publicURL
}

// Close closes the listener and Tailscale node cleanly
func (h *Host) Close() error {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.closed {
		return nil
	}
	h.closed = true

	var errs []error
	if h.listener != nil {
		if err := h.listener.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	if h.tsServer != nil {
		if err := h.tsServer.Close(); err != nil {
			errs = append(errs, err)
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("errors closing Tailscale host: %v", errs)
	}
	return nil
}
