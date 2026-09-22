package wisp

import (
	"context"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"interstellar-proxy/pkg/security"
)

func TestWispServerSSRFBlocking(t *testing.T) {
	wispServer := NewServer(Config{})
	ts := httptest.NewServer(wispServer)
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	c, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		Subprotocols: []string{"wisp-v1"},
	})
	if err != nil {
		t.Fatalf("failed to dial wisp server: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "done")

	// Read initial CONTINUE packet
	_, msg, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("failed to read initial continue: %v", err)
	}
	pkt, err := ParsePacket(msg)
	if err != nil || pkt.Type != PacketContinue {
		t.Fatalf("expected CONTINUE packet, got %v (type %d)", err, pkt.Type)
	}

	// Now try to CONNECT to 127.0.0.1:80 (Loopback - SSRF attack!)
	var payload []byte
	payload = append(payload, StreamTCP)
	portBuf := make([]byte, 2)
	binary.LittleEndian.PutUint16(portBuf, 80)
	payload = append(payload, portBuf...)
	payload = append(payload, []byte("127.0.0.1")...)

	connectPkt := &Packet{
		Type:     PacketConnect,
		StreamID: 1,
		Payload:  payload,
	}

	err = c.Write(ctx, websocket.MessageBinary, connectPkt.Serialize())
	if err != nil {
		t.Fatalf("failed to write connect packet: %v", err)
	}

	// Server MUST reply with a CLOSE packet with ReasonHostBlocked (0x48)
	_, closeMsg, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("failed to read close reply: %v", err)
	}
	replyPkt, err := ParsePacket(closeMsg)
	if err != nil {
		t.Fatalf("failed to parse reply packet: %v", err)
	}
	if replyPkt.Type != PacketClose {
		t.Fatalf("expected CLOSE packet, got type %d", replyPkt.Type)
	}
	if len(replyPkt.Payload) < 1 || replyPkt.Payload[0] != ReasonHostBlocked {
		t.Fatalf("expected ReasonHostBlocked (0x48), got %x", replyPkt.Payload)
	}
}

func TestWispServerAuth(t *testing.T) {
	auth := &security.AuthConfig{
		Enabled:  true,
		Password: "secret-token",
	}
	wispServer := NewServer(Config{Auth: auth})
	ts := httptest.NewServer(wispServer)
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// Dial without auth should fail
	_, _, err := websocket.Dial(ctx, wsURL, nil)
	if err == nil {
		t.Fatal("expected dial without auth to fail")
	}

	// Dial with auth should succeed
	_, resp, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Authorization": []string{"Basic aW50ZXJzdGVsbGFyOnNlY3JldC10b2tlbg=="}, // interstellar:secret-token
		},
	})
	if err != nil {
		t.Fatalf("expected dial with auth to succeed, got %v (resp: %v)", err, resp)
	}
}
