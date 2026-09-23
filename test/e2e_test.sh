#!/usr/bin/env bash
set -euo pipefail

echo "============================================="
echo "  Running End-to-End Interstellar Proxy Test"
echo "============================================="

PORT=19090
BINARY="/workspace/interstellar-proxy"

echo "[1] Starting server in background on port $PORT..."
$BINARY -no-tailscale -port $PORT &
SERVER_PID=$!

cleanup() {
    echo "[Cleanup] Stopping server (PID: $SERVER_PID)..."
    kill -INT $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
    echo "[Cleanup] Done."
}
trap cleanup EXIT

# Wait for server to come up
echo "[2] Waiting for server to become ready..."
for i in {1..30}; do
    if curl -s "http://127.0.0.1:$PORT/" > /dev/null; then
        echo "Server is ready!"
        break
    fi
    sleep 0.2
done

echo "[3] Testing HTTP routes..."
# Home
echo -n "  Testing /: "
curl -s -f "http://127.0.0.1:$PORT/" | grep -qi "<!doctype html"
echo "OK"

# Apps
echo -n "  Testing /apps: "
curl -s -f "http://127.0.0.1:$PORT/apps" > /dev/null
echo "OK"

# Games
echo -n "  Testing /games: "
curl -s -f "http://127.0.0.1:$PORT/games" > /dev/null
echo "OK"

# Tabs
echo -n "  Testing /tabs: "
curl -s -f "http://127.0.0.1:$PORT/tabs" > /dev/null
echo "OK"

# Settings
echo -n "  Testing /settings: "
curl -s -f "http://127.0.0.1:$PORT/settings" > /dev/null
echo "OK"

echo "[4] Testing Service Worker headers..."
SW_HEADERS=$(curl -s -I "http://127.0.0.1:$PORT/queue.js")
echo "$SW_HEADERS" | grep -qi "Service-Worker-Allowed: /"
echo "$SW_HEADERS" | grep -qi "Content-Type: text/javascript"
echo "  Service-Worker headers: OK"

echo "[5] Testing Security: Hidden file protection..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/.runtime/vendor-map.cjs")
if [ "$HTTP_CODE" -ne 404 ]; then
    echo "FAILED: .runtime should be 404, got $HTTP_CODE"
    exit 1
fi
echo "  .runtime blocked with 404: OK"

echo "[6] Testing Wisp WebSocket proxy live..."
node << 'EOF'
import { ClientConnection } from "/tmp/interstellar/node_modules/@mercuryworkshop/wisp-js/src/client/index.mjs";

const client = new ClientConnection("ws://127.0.0.1:19090/wisp/");
client.onopen = () => {
    console.log("  Connected to Wisp WebSocket!");
    const stream = client.create_stream("example.com", 80, "tcp");
    stream.onmessage = (data) => {
        const text = new TextDecoder().decode(data);
        if (text.includes("HTTP/")) {
            console.log("  Proxy stream received valid HTTP response from example.com: OK");
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
    console.error("Timeout waiting for proxy response");
    process.exit(1);
}, 5000);
EOF

echo "[7] Testing Wisp SSRF Protection (Attempting to proxy to loopback 127.0.0.1)..."
node << 'EOF'
import { ClientConnection } from "/tmp/interstellar/node_modules/@mercuryworkshop/wisp-js/src/client/index.mjs";

const client = new ClientConnection("ws://127.0.0.1:19090/wisp/");
client.onopen = () => {
    const stream = client.create_stream("127.0.0.1", 19090, "tcp");
    stream.onclose = (reason) => {
        // ReasonHostBlocked is 0x48 = 72
        if (reason === 72) {
            console.log("  SSRF connection to 127.0.0.1 was BLOCKED with ReasonHostBlocked (0x48): OK");
            client.close();
            process.exit(0);
        } else {
            console.error("Stream closed with unexpected reason:", reason);
            process.exit(1);
        }
    };
    stream.onmessage = () => {
        console.error("SSRF attack SUCCEEDED! This should have been blocked!");
        process.exit(1);
    };
};
setTimeout(() => {
    console.error("Timeout waiting for SSRF rejection");
    process.exit(1);
}, 5000);
EOF

echo "============================================="
echo "  ALL END-TO-END TESTS PASSED SUCCESSFULLY!  "
echo "============================================="
