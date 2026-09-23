package security

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"time"
)

var (
	ErrBlockedIP      = errors.New("destination IP is blocked (private/loopback/restricted)")
	ErrBlockedPort    = errors.New("destination port is blocked for security")
	ErrBlockedHost    = errors.New("destination hostname is blocked for security")
	ErrResolutionFail = errors.New("failed to resolve destination hostname")
	ErrNoIPFound      = errors.New("no IP address found for destination")
)

// Blocked CIDR ranges (IPv4 & IPv6)
var blockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),          // "This" network
	netip.MustParsePrefix("10.0.0.0/8"),         // RFC 1918 Private
	netip.MustParsePrefix("100.64.0.0/10"),      // Carrier-Grade NAT / Tailscale CGNAT
	netip.MustParsePrefix("127.0.0.0/8"),        // Loopback
	netip.MustParsePrefix("169.254.0.0/16"),     // Link-Local & Cloud Metadata (169.254.169.254)
	netip.MustParsePrefix("172.16.0.0/12"),      // RFC 1918 Private
	netip.MustParsePrefix("192.0.0.0/24"),       // IETF Protocol Assignments
	netip.MustParsePrefix("192.0.2.0/24"),       // TEST-NET-1
	netip.MustParsePrefix("192.168.0.0/16"),     // RFC 1918 Private
	netip.MustParsePrefix("198.18.0.0/15"),      // Benchmark Testing
	netip.MustParsePrefix("198.51.100.0/24"),    // TEST-NET-2
	netip.MustParsePrefix("203.0.113.0/24"),     // TEST-NET-3
	netip.MustParsePrefix("224.0.0.0/4"),        // Multicast
	netip.MustParsePrefix("240.0.0.0/4"),        // Reserved
	netip.MustParsePrefix("255.255.255.255/32"), // Broadcast
	netip.MustParsePrefix("::/128"),             // Unspecified
	netip.MustParsePrefix("::1/128"),            // Loopback
	netip.MustParsePrefix("fc00::/7"),           // Unique Local Address (IPv6 Private)
	netip.MustParsePrefix("fe80::/10"),          // Link-Local
	netip.MustParsePrefix("ff00::/8"),           // Multicast
}

// Blocked ports representing dangerous, non-web services
var blockedPorts = map[uint16]string{
	0:    "Reserved",
	21:   "FTP",
	22:   "SSH",
	23:   "Telnet",
	25:   "SMTP (Prevent spam)",
	53:   "DNS",
	69:   "TFTP",
	110:  "POP3",
	135:  "Windows RPC",
	137:  "NetBIOS Name",
	138:  "NetBIOS Datagram",
	139:  "NetBIOS Session",
	143:  "IMAP",
	445:  "SMB",
	1433: "MSSQL",
	1521: "Oracle",
	3306: "MySQL",
	3389: "RDP",
	5353: "mDNS",
	5432: "PostgreSQL",
	5900: "VNC",
	6379: "Redis",
	9200: "Elasticsearch",
	11211: "Memcached",
	27017: "MongoDB",
}

// IsBlockedPort checks whether a target port is blocked for security
func IsBlockedPort(port uint16) bool {
	_, blocked := blockedPorts[port]
	return blocked
}

// IsBlockedIP checks if an IP is in any private, loopback, or dangerous CIDR
func IsBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}

	// Unwrap IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}

	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return true
	}
	// Unmap in netip.Addr as well
	addr = addr.Unmap()

	if addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() ||
		addr.IsLinkLocalMulticast() || addr.IsInterfaceLocalMulticast() ||
		addr.IsMulticast() || addr.IsUnspecified() {
		return true
	}

	for _, prefix := range blockedPrefixes {
		if prefix.Contains(addr) {
			return true
		}
	}

	return false
}

// ValidateHostname checks for dangerous hostnames
func ValidateHostname(host string) error {
	host = strings.TrimSpace(strings.ToLower(host))
	if host == "" {
		return errors.New("empty hostname")
	}
	if len(host) > 253 {
		return errors.New("hostname too long")
	}

	// Strip trailing dot if present
	host = strings.TrimSuffix(host, ".")

	if host == "localhost" || strings.HasSuffix(host, ".localhost") ||
		strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") ||
		strings.HasSuffix(host, ".lan") || strings.HasSuffix(host, ".home") ||
		strings.HasSuffix(host, ".corp") || strings.HasSuffix(host, ".invalid") ||
		strings.HasSuffix(host, ".test") || strings.HasSuffix(host, ".arpa") {
		return fmt.Errorf("%w: %s", ErrBlockedHost, host)
	}

	return nil
}

// TargetResolver resolves a hostname and ensures ALL resolved IPs are safe public IPs.
// It returns a safe IP to dial, preventing DNS rebinding.
type TargetResolver struct {
	Resolver *net.Resolver
	Timeout  time.Duration
}

// NewTargetResolver creates a resolver with a default 5-second timeout
func NewTargetResolver() *TargetResolver {
	return &TargetResolver{
		Resolver: net.DefaultResolver,
		Timeout:  5 * time.Second,
	}
}

// ResolveAndValidate resolves a hostname and verifies it is safe to connect to.
// Returns a chosen safe IP string (or error if blocked).
func (r *TargetResolver) ResolveAndValidate(ctx context.Context, hostname string, port uint16) (net.IP, error) {
	if IsBlockedPort(port) {
		return nil, fmt.Errorf("%w: port %d is restricted", ErrBlockedPort, port)
	}

	// Check if hostname is directly an IP address
	if ip := net.ParseIP(hostname); ip != nil {
		if IsBlockedIP(ip) {
			return nil, fmt.Errorf("%w: IP %s is not permitted", ErrBlockedIP, ip.String())
		}
		return ip, nil
	}

	if err := ValidateHostname(hostname); err != nil {
		return nil, err
	}

	resolveCtx, cancel := context.WithTimeout(ctx, r.Timeout)
	defer cancel()

	ips, err := r.Resolver.LookupIP(resolveCtx, "ip", hostname)
	if err != nil {
		return nil, fmt.Errorf("%w for %s: %v", ErrResolutionFail, hostname, err)
	}

	if len(ips) == 0 {
		return nil, fmt.Errorf("%w for %s", ErrNoIPFound, hostname)
	}

	// STRICT CHECK: If ANY resolved IP address is in a blocked range,
	// the entire hostname is rejected! This prevents split-horizon / DNS rebinding attacks.
	var safeIP net.IP
	for _, ip := range ips {
		if IsBlockedIP(ip) {
			return nil, fmt.Errorf("%w: resolved to blocked IP %s", ErrBlockedIP, ip.String())
		}
		if safeIP == nil {
			safeIP = ip
		}
	}

	return safeIP, nil
}
