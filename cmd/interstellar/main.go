package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	interstellar "interstellar-proxy"
	"interstellar-proxy/pkg/security"
	"interstellar-proxy/pkg/server"
	"interstellar-proxy/pkg/tailscale"
	"interstellar-proxy/pkg/wisp"
)

const version = "6.0.0-tailscale"

func main() {
	var (
		portFlag        = flag.Int("port", 8080, "Local port to listen on for HTTP")
		noLocalFlag     = flag.Bool("no-local", false, "Disable the local HTTP server and only use Tailscale")
		hostnameFlag    = flag.String("hostname", "interstellar-proxy", "Tailscale machine/hostname")
		funnelFlag      = flag.Bool("funnel", true, "Enable Tailscale Funnel (public HTTPS URL accessible from ANY Wi-Fi)")
		authKeyFlag     = flag.String("authkey", os.Getenv("TS_AUTHKEY"), "Tailscale auth key (optional; if omitted, prints interactive login link)")
		passwordFlag    = flag.String("password", os.Getenv("PROXY_PASSWORD"), "Password protect the proxy (optional)")
		stateDirFlag    = flag.String("state-dir", "", "Directory to store Tailscale state (defaults to OS user config dir)")
		rateLimitFlag   = flag.Int("rate-limit", 120, "Rate limit in requests per minute per IP")
		maxStreamsFlag  = flag.Int("max-streams", 64, "Maximum concurrent proxy streams per connection")
		noTailscaleFlag = flag.Bool("no-tailscale", false, "Run local HTTP server only without Tailscale")
		verboseFlag     = flag.Bool("verbose", false, "Enable verbose Tailscale internal logs")
		versionFlag     = flag.Bool("version", false, "Print version and exit")
	)
	flag.Parse()

	if *versionFlag {
		fmt.Printf("Interstellar Proxy Host v%s\n", version)
		os.Exit(0)
	}

	authStatus := "DISABLED (Public access)"
	if *passwordFlag != "" {
		authStatus = fmt.Sprintf("ENABLED (Password: %s)", *passwordFlag)
	}

	fmt.Println()
	fmt.Println("================================================================================")
	fmt.Println("       ⭐ INTERSTELLAR SCHOOL PROXY - TAILSCALE HOST (.EXE) ⭐")
	fmt.Println("================================================================================")
	fmt.Println("  Turn your PC into a high-speed, secure school proxy server!")
	fmt.Println("  People on other Wi-Fi networks can access it via your secure Tailscale URL.")
	fmt.Println("================================================================================")
	fmt.Println("  [SECURITY STATUS]")
	fmt.Println("   ✓ Anti-SSRF Protection:      ENABLED (Loopback, 192.168.x, 10.x, CGNAT blocked)")
	fmt.Println("   ✓ Anti-DNS Rebinding:        ENABLED (Pinning to verified public IPs)")
	fmt.Println("   ✓ Dangerous Port Filter:     ENABLED (SSH, SMB, RPC, SMTP, DB ports blocked)")
	fmt.Println("   ✓ Adware & Trackers:         REMOVED (Zero adware popups or scripts)")
	fmt.Printf("   ✓ DoS Rate Limiting:         ENABLED (%d requests/min per IP)\n", *rateLimitFlag)
	fmt.Printf("   ✓ Password Protection:       %s\n", authStatus)
	fmt.Println("================================================================================")
	fmt.Println()

	// 1. Setup Security & Authentication
	authConfig := &security.AuthConfig{
		Enabled:  *passwordFlag != "",
		Password: *passwordFlag,
	}

	rateLimiter := security.NewRateLimiter(*rateLimitFlag)
	targetResolver := security.NewTargetResolver()

	// 2. Setup Wisp WebSocket Proxy Server
	wispServer := wisp.NewServer(wisp.Config{
		Resolver:          targetResolver,
		Auth:              authConfig,
		MaxStreamsPerConn: *maxStreamsFlag,
		BufferSize:        128,
		DialTimeout:       10 * time.Second,
		StreamIdleTimeout: 90 * time.Second,
	})

	// 3. Setup HTTP Application Server (Embedded Frontend, Routes, Games Proxy)
	appServer, err := server.NewServer(server.Config{
		Assets:      interstellar.DistFS,
		WispServer:  wispServer,
		Auth:        authConfig,
		RateLimiter: rateLimiter,
	})
	if err != nil {
		log.Fatalf("Failed to initialize server: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 4. Start Local HTTP Server
	var localServer *http.Server
	if !*noLocalFlag {
		localAddr := fmt.Sprintf(":%d", *portFlag)
		localServer = &http.Server{
			Addr:              localAddr,
			Handler:           appServer,
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       120 * time.Second,
		}

		go func() {
			log.Printf("[Local] Starting HTTP server on http://localhost:%d", *portFlag)
			if err := localServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Printf("[Local Error] HTTP server exited: %v", err)
			}
		}()

		// Print local LAN IPs for convenience
		if addrs, err := net.InterfaceAddrs(); err == nil {
			for _, addr := range addrs {
				if ipNet, ok := addr.(*net.IPNet); ok && !ipNet.IP.IsLoopback() && ipNet.IP.To4() != nil {
					log.Printf("[Local LAN] Also accessible on your home Wi-Fi at http://%s:%d", ipNet.IP.String(), *portFlag)
				}
			}
		}
	}

	// 5. Start Tailscale Host
	var tsHost *tailscale.Host
	if !*noTailscaleFlag {
		var stateDir string
		if *stateDirFlag != "" {
			stateDir = *stateDirFlag
		} else {
			stateDir = tailscale.DefaultStateDir()
		}

		tsHost, err = tailscale.NewHost(tailscale.Config{
			Hostname:     *hostnameFlag,
			StateDir:     stateDir,
			AuthKey:      *authKeyFlag,
			EnableFunnel: *funnelFlag,
			VerboseLogs:  *verboseFlag,
		})
		if err != nil {
			log.Fatalf("Failed to initialize Tailscale: %v", err)
		}

		go func() {
			if startErr := tsHost.Start(ctx, appServer); startErr != nil {
				log.Printf("[Tailscale Error] Failed to start Tailscale server: %v", startErr)
			}
		}()
	}

	// 6. Wait for Shutdown Signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	sig := <-sigChan
	log.Printf("\nReceived shutdown signal (%v). Stopping Interstellar Proxy...", sig)

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()

	if localServer != nil {
		_ = localServer.Shutdown(shutdownCtx)
	}
	if tsHost != nil {
		_ = tsHost.Close()
	}

	log.Println("Server stopped cleanly. Goodbye!")
}
