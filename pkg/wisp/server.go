package wisp

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"interstellar-proxy/pkg/security"
)

// Stream represents an active proxied TCP/UDP connection
type Stream struct {
	id     uint32
	conn   net.Conn
	closed atomic.Bool
	mu     sync.Mutex
}

// Server handles Wisp WebSocket proxy connections
type Server struct {
	resolver          *security.TargetResolver
	auth              *security.AuthConfig
	maxStreamsPerConn int
	bufferSize        uint32
	dialTimeout       time.Duration
	streamIdleTimeout time.Duration
}

// Config provides configuration for the Wisp server
type Config struct {
	Resolver          *security.TargetResolver
	Auth              *security.AuthConfig
	MaxStreamsPerConn int
	BufferSize        uint32
	DialTimeout       time.Duration
	StreamIdleTimeout time.Duration
}

// NewServer creates a new Wisp proxy server with security protections
func NewServer(cfg Config) *Server {
	if cfg.Resolver == nil {
		cfg.Resolver = security.NewTargetResolver()
	}
	if cfg.MaxStreamsPerConn <= 0 {
		cfg.MaxStreamsPerConn = 64
	}
	if cfg.BufferSize == 0 {
		cfg.BufferSize = 128
	}
	if cfg.DialTimeout == 0 {
		cfg.DialTimeout = 10 * time.Second
	}
	if cfg.StreamIdleTimeout == 0 {
		cfg.StreamIdleTimeout = 90 * time.Second
	}

	return &Server{
		resolver:          cfg.Resolver,
		auth:              cfg.Auth,
		maxStreamsPerConn: cfg.MaxStreamsPerConn,
		bufferSize:        cfg.BufferSize,
		dialTimeout:       cfg.DialTimeout,
		streamIdleTimeout: cfg.StreamIdleTimeout,
	}
}

// ServeHTTP handles the Wisp WebSocket upgrade and proxy lifecycle
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// 1. Authentication check
	if s.auth != nil && s.auth.Enabled {
		user, pass, ok := r.BasicAuth()
		if !ok || !s.auth.CheckCredentials(user, pass) {
			w.Header().Set("WWW-Authenticate", `Basic realm="Interstellar Secure Proxy"`)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
	}

	// 2. Accept WebSocket connection
	opts := &websocket.AcceptOptions{
		Subprotocols:       []string{"wisp-v2", "wisp-v1"},
		InsecureSkipVerify: true, // Allow connections from any origin (e.g. Tailscale Funnel)
	}

	c, err := websocket.Accept(w, r, opts)
	if err != nil {
		log.Printf("[WISP] WebSocket upgrade failed from %s: %v", r.RemoteAddr, err)
		return
	}
	defer c.Close(websocket.StatusNormalClosure, "server closing")

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	subprotocol := c.Subprotocol()
	clientIP := security.ExtractIP(r)
	log.Printf("[WISP] New connection from %s (subprotocol: %s)", clientIP, subprotocol)

	// Mutex for writing to the WebSocket safely across goroutines
	var wsMu sync.Mutex
	writePacket := func(data []byte) error {
		wsMu.Lock()
		defer wsMu.Unlock()
		writeCtx, writeCancel := context.WithTimeout(ctx, 10*time.Second)
		defer writeCancel()
		return c.Write(writeCtx, websocket.MessageBinary, data)
	}

	// If client requested Wisp v2, send initial INFO packet
	if subprotocol == "wisp-v2" {
		infoPkt := BuildInfoPacket(2, 0, nil)
		if err := writePacket(infoPkt); err != nil {
			log.Printf("[WISP] Failed to send INFO packet: %v", err)
			return
		}
	}

	// Send initial CONTINUE packet on stream 0 to initiate flow control
	initContinue := BuildContinuePacket(0, s.bufferSize)
	if err := writePacket(initContinue); err != nil {
		log.Printf("[WISP] Failed to send initial CONTINUE: %v", err)
		return
	}

	// Stream tracking for this WebSocket session
	streams := make(map[uint32]*Stream)
	var streamsMu sync.Mutex

	closeStream := func(streamID uint32, reason byte) {
		streamsMu.Lock()
		stream, exists := streams[streamID]
		if exists {
			delete(streams, streamID)
		}
		streamsMu.Unlock()

		if exists && stream != nil {
			if stream.closed.CompareAndSwap(false, true) {
				stream.mu.Lock()
				if stream.conn != nil {
					_ = stream.conn.Close()
				}
				stream.mu.Unlock()

				closePkt := BuildClosePacket(streamID, reason)
				_ = writePacket(closePkt)
			}
		} else {
			// Stream wasn't registered yet (e.g. blocked or failed to dial)
			closePkt := BuildClosePacket(streamID, reason)
			_ = writePacket(closePkt)
		}
	}

	// Cleanup all streams when WebSocket terminates
	defer func() {
		streamsMu.Lock()
		defer streamsMu.Unlock()
		for id, st := range streams {
			if st.closed.CompareAndSwap(false, true) {
				st.mu.Lock()
				if st.conn != nil {
					_ = st.conn.Close()
				}
				st.mu.Unlock()
			}
			delete(streams, id)
		}
	}()

	// Main packet processing loop
	for {
		readType, msg, err := c.Read(ctx)
		if err != nil {
			// Normal disconnect or context cancelled
			break
		}
		if readType != websocket.MessageBinary || len(msg) < 5 {
			continue
		}

		pkt, err := ParsePacket(msg)
		if err != nil {
			continue
		}

		switch pkt.Type {
		case PacketConnect:
			connectData, err := ParseConnectPayload(pkt.Payload)
			if err != nil {
				closeStream(pkt.StreamID, ReasonInvalidInfo)
				continue
			}

			// Enforce concurrent stream limit
			streamsMu.Lock()
			currentStreamCount := len(streams)
			streamsMu.Unlock()

			if currentStreamCount >= s.maxStreamsPerConn {
				log.Printf("[SECURITY] Stream limit exceeded for %s (active: %d, max: %d)",
					clientIP, currentStreamCount, s.maxStreamsPerConn)
				closeStream(pkt.StreamID, ReasonConnThrottled)
				continue
			}

			// Only allow TCP streams for web proxy
			if connectData.StreamType != StreamTCP {
				log.Printf("[SECURITY] Unsupported stream type 0x%02x from %s", connectData.StreamType, clientIP)
				closeStream(pkt.StreamID, ReasonHostBlocked)
				continue
			}

			// --- STRICT SSRF & SECURITY VALIDATION ---
			safeIP, err := s.resolver.ResolveAndValidate(ctx, connectData.Hostname, connectData.Port)
			if err != nil {
				log.Printf("[SECURITY BLOCKED] Target %s:%d from %s was REJECTED: %v",
					connectData.Hostname, connectData.Port, clientIP, err)
				closeStream(pkt.StreamID, ReasonHostBlocked)
				continue
			}

			// Dial the validated public IP directly (Prevents DNS rebinding!)
			targetAddr := net.JoinHostPort(safeIP.String(), fmt.Sprintf("%d", connectData.Port))
			dialer := net.Dialer{
				Timeout: s.dialTimeout,
			}

			tcpConn, err := dialer.DialContext(ctx, "tcp", targetAddr)
			if err != nil {
				log.Printf("[WISP] Dial to %s (%s:%d) failed: %v",
					targetAddr, connectData.Hostname, connectData.Port, err)
				closeStream(pkt.StreamID, ReasonConnRefused)
				continue
			}

			stream := &Stream{
				id:   pkt.StreamID,
				conn: tcpConn,
			}

			streamsMu.Lock()
			streams[pkt.StreamID] = stream
			streamsMu.Unlock()

			// Acknowledge connection with CONTINUE packet
			ackPkt := BuildContinuePacket(pkt.StreamID, s.bufferSize)
			if err := writePacket(ackPkt); err != nil {
				closeStream(pkt.StreamID, ReasonNetworkError)
				continue
			}

			// Goroutine to stream TCP data -> WebSocket
			go func(st *Stream) {
				defer closeStream(st.id, ReasonVoluntary)

				buf := make([]byte, 32768)
				for {
					_ = st.conn.SetReadDeadline(time.Now().Add(s.streamIdleTimeout))
					n, err := st.conn.Read(buf)
					if n > 0 {
						dataPkt := BuildDataPacket(st.id, buf[:n])
						if err := writePacket(dataPkt); err != nil {
							return
						}
					}
					if err != nil {
						if err != io.EOF && !st.closed.Load() {
							// Connection closed or timed out
						}
						return
					}
				}
			}(stream)

		case PacketData:
			streamsMu.Lock()
			stream, exists := streams[pkt.StreamID]
			streamsMu.Unlock()

			if exists && stream != nil && !stream.closed.Load() {
				stream.mu.Lock()
				conn := stream.conn
				stream.mu.Unlock()

				if conn != nil {
					_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
					_, writeErr := conn.Write(pkt.Payload)
					if writeErr != nil {
						closeStream(pkt.StreamID, ReasonNetworkError)
						continue
					}

					// Send CONTINUE packet to acknowledge received data
					contPkt := BuildContinuePacket(pkt.StreamID, s.bufferSize)
					_ = writePacket(contPkt)
				}
			}

		case PacketClose:
			closeStream(pkt.StreamID, ReasonVoluntary)

		case PacketInfo:
			// Respond to client INFO if requested
			infoPkt := BuildInfoPacket(2, 0, nil)
			_ = writePacket(infoPkt)
		}
	}
}
