# Interstellar Proxy - Standalone Tailscale Server (.exe)

A single-file, self-contained Windows executable (`interstellar-proxy.exe`) that turns any PC into a secure, high-speed hosting server for the **Interstellar School Proxy** using **Tailscale Funnel**.

People on **other Wi-Fi networks, school Chromebooks, phones, and laptops** can access the proxy through a secure, public HTTPS Tailscale URL—**no port forwarding or client installation required**.

---

## 🚀 Quick Start (Running on Windows)

1. Download or copy `interstellar-proxy.exe` to your Windows PC.
2. Double-click `interstellar-proxy.exe` (or open Command Prompt / PowerShell and run `./interstellar-proxy.exe`).
3. On first run, a Tailscale login link will appear in the console if you aren't using an auth key:
   ```
   👉 ACTION REQUIRED: LOG IN TO TAILSCALE TO HOST PUBLIC PROXY:
      https://login.tailscale.com/a/...
   ```
4. Open the link in your browser to approve the node in your Tailscale account. (Login state is saved in `%LocalAppData%\InterstellarProxy`, so you only ever have to do this once!).
5. Once authenticated, your public HTTPS URL will be displayed:
   ```
   ╔══════════════════════════════════════════════════════════════════════════╗
   ║  🌐 PUBLIC PROXY URL (Accessible from ANY Wi-Fi or device):              ║
   ║     https://interstellar-proxy.your-tailnet.ts.net/                      ║
   ╚══════════════════════════════════════════════════════════════════════════╝
   ```
6. Anyone on **any other Wi-Fi network** can open that URL in their web browser to use the proxy!

---

## 🔒 Security Architecture: "So You Can't Get Hacked"

Hosting a public proxy server on a home or personal PC carries major security risks if done improperly. This executable is built with a **strict defense-in-depth security model**:

### 1. Strict Anti-SSRF (Intranet Pivoting Prevention)
* **What could go wrong**: Attackers could use a proxy to scan `localhost`, access router admin pages (`192.168.1.1`), hack smart home devices, or access cloud metadata services.
* **Our Protection**:
  * **Zero Private Network Access**: Every target IP is strictly checked before connecting. Connections to `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `fe80::/10`, and `fc00::/7` are rejected instantly with `ReasonHostBlocked`.
  * **Tailnet Isolation**: The Tailscale Carrier-Grade NAT range (`100.64.0.0/10`) is blocked so internet users cannot use the proxy to attack other devices in your private Tailnet.

### 2. Anti-DNS Rebinding Protection
* Hostnames are resolved via DNS, and **every** resolved IP is inspected. If even one resolved IP points to an internal or private address, the entire connection is rejected.
* The proxy pins and dials the verified public IP address directly (`net.Dial`), eliminating time-of-check to time-of-use (TOCTOU) DNS rebinding attacks.

### 3. Dangerous Port Filtering
* Dangerous non-web protocol ports are blocked by default:
  * SSH (22), Telnet (23), SMTP (25 - prevents sending spam from your IP), DNS (53), POP3/IMAP (110, 143), Windows RPC & SMB (135, 137, 138, 139, 445), RDP (3389), mDNS (5353), and database ports (3306, 5432, 6379, 27017).

### 4. Zero Adware / Trackers
* The original upstream frontend contained an intrusive adware pop-up script pointing to external ad networks (`undercoverhiking.com`). This adware has been **completely removed and sanitized**.

### 5. DoS & Flooding Protection
* Built-in per-IP token bucket rate limiting (default: 120 req/min).
* Hard limit on concurrent proxy streams per WebSocket client (default: 64 streams).
* TCP read/write deadlines and inactivity timeouts to prevent file descriptor exhaustion.

### 6. Optional Password Protection
* Want only your friends to use the proxy? Run with `--password <your_password>`.
* Enforces HTTP Basic Auth across all pages and WebSocket connections.

---

## ⚙️ Command-Line Flags & Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `-port <number>` | `8080` | Local HTTP port to listen on |
| `-no-local` | `false` | Disable local HTTP server; only serve on Tailscale |
| `-hostname <name>` | `interstellar-proxy` | Machine name in your Tailnet |
| `-funnel` | `true` | Enable Tailscale Funnel for public internet HTTPS |
| `-authkey <key>` | `$TS_AUTHKEY` | Tailscale auth key (optional, avoids web login) |
| `-password <pwd>` | `$PROXY_PASSWORD` | Password protect the proxy |
| `-state-dir <dir>` | OS config dir | Directory to persist Tailscale login session |
| `-rate-limit <n>` | `120` | Max HTTP requests per minute per IP |
| `-max-streams <n>` | `64` | Max concurrent proxy streams per connection |
| `-no-tailscale` | `false` | Run as local-only HTTP proxy without Tailscale |
| `-verbose` | `false` | Enable verbose Tailscale logging |
| `-version` | — | Display version and exit |

---

## 🛠️ Building From Source

Prerequisites: Go 1.22+

### To build the Windows `.exe`:
```bash
GOOS=windows GOARCH=amd64 go build -o interstellar-proxy.exe ./cmd/interstellar
```

### To build for Linux:
```bash
go build -o interstellar-proxy ./cmd/interstellar
```

### To build for macOS (Apple Silicon / Intel):
```bash
GOOS=darwin GOARCH=arm64 go build -o interstellar-proxy-mac ./cmd/interstellar
```

---

## 🧪 Testing

Run all unit tests and integration tests:
```bash
go test -v ./...
```

Run the end-to-end automated test suite:
```bash
./test/e2e_test.sh
```
