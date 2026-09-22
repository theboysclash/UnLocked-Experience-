package wisp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestNodeWispClientCompatibility(t *testing.T) {
	// Skip if node is not available
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}

	wispServer := NewServer(Config{})
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/wisp") {
			wispServer.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/wisp/"

	nodeScript := `
import { ClientConnection } from "/tmp/interstellar/node_modules/@mercuryworkshop/wisp-js/src/client/index.mjs";

const client = new ClientConnection(process.env.TEST_WS_URL);
client.onopen = () => {
    const stream = client.create_stream("example.com", 80, "tcp");
    stream.onopen = () => {};
    stream.onmessage = (data) => {
        const text = new TextDecoder().decode(data);
        if (text.includes("HTTP/")) {
            stream.close();
            client.close();
            process.exit(0);
        }
    };
    stream.send(new TextEncoder().encode("HEAD / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n"));
};
client.onerror = (err) => {
    console.error("Client error:", err);
    process.exit(1);
};
setTimeout(() => {
    console.error("Timeout waiting for response");
    process.exit(1);
}, 6000);
`

	scriptFile, err := os.CreateTemp("", "test-node-wisp-*.mjs")
	if err != nil {
		t.Fatalf("failed to create temp file: %v", err)
	}
	defer os.Remove(scriptFile.Name())
	_, _ = scriptFile.WriteString(nodeScript)
	_ = scriptFile.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "node", scriptFile.Name())
	cmd.Env = append(os.Environ(), "TEST_WS_URL="+wsURL)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node client failed: %v\nOutput:\n%s", err, string(out))
	}
}
