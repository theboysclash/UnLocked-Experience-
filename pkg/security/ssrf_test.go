package security

import (
	"context"
	"net"
	"testing"
)

func TestIsBlockedIP(t *testing.T) {
	tests := []struct {
		ip      string
		blocked bool
	}{
		// Loopback
		{"127.0.0.1", true},
		{"127.1.2.3", true},
		{"::1", true},

		// Private RFC 1918
		{"10.0.0.1", true},
		{"10.255.255.254", true},
		{"172.16.0.1", true},
		{"172.31.255.254", true},
		{"192.168.1.1", true},
		{"192.168.0.100", true},

		// Cloud Metadata & Link-Local
		{"169.254.169.254", true},
		{"169.254.1.1", true},
		{"fe80::1", true},

		// CGNAT / Tailscale range (100.64.0.0/10)
		{"100.64.0.1", true},
		{"100.100.100.100", true},
		{"100.127.255.254", true},

		// IPv6 Unique Local
		{"fc00::1", true},
		{"fd12:3456:789a::1", true},

		// IPv4-mapped IPv6
		{"::ffff:127.0.0.1", true},
		{"::ffff:192.168.1.1", true},
		{"::ffff:10.0.0.5", true},

		// Public IPs (should NOT be blocked)
		{"8.8.8.8", false},
		{"1.1.1.1", false},
		{"93.184.216.34", false},
		{"2606:4700:4700::1111", false},
	}

	for _, tc := range tests {
		ip := net.ParseIP(tc.ip)
		if ip == nil {
			t.Fatalf("failed to parse IP: %s", tc.ip)
		}
		res := IsBlockedIP(ip)
		if res != tc.blocked {
			t.Errorf("IsBlockedIP(%s) = %v, want %v", tc.ip, res, tc.blocked)
		}
	}
}

func TestBlockedPorts(t *testing.T) {
	dangerous := []uint16{0, 21, 22, 23, 25, 53, 110, 135, 139, 143, 445, 3389, 5353, 6379}
	for _, p := range dangerous {
		if !IsBlockedPort(p) {
			t.Errorf("expected port %d to be blocked", p)
		}
	}

	safe := []uint16{80, 443, 8080, 8443, 3000, 9000}
	for _, p := range safe {
		if IsBlockedPort(p) {
			t.Errorf("expected port %d to be allowed", p)
		}
	}
}

func TestValidateHostname(t *testing.T) {
	badHosts := []string{
		"localhost",
		"sub.localhost",
		"printer.local",
		"internal.service.lan",
		"test.corp",
		"router.home",
	}

	for _, h := range badHosts {
		if err := ValidateHostname(h); err == nil {
			t.Errorf("expected hostname %s to be rejected", h)
		}
	}

	goodHosts := []string{
		"google.com",
		"discord.com",
		"github.com",
		"wikipedia.org",
	}

	for _, h := range goodHosts {
		if err := ValidateHostname(h); err != nil {
			t.Errorf("expected hostname %s to be accepted, got: %v", h, err)
		}
	}
}

func TestResolveAndValidate(t *testing.T) {
	resolver := NewTargetResolver()
	ctx := context.Background()

	// Should block loopback direct IP
	_, err := resolver.ResolveAndValidate(ctx, "127.0.0.1", 80)
	if err == nil {
		t.Error("expected error for 127.0.0.1")
	}

	// Should block restricted port
	_, err = resolver.ResolveAndValidate(ctx, "1.1.1.1", 22)
	if err == nil {
		t.Error("expected error for port 22")
	}

	// Should block localhost
	_, err = resolver.ResolveAndValidate(ctx, "localhost", 80)
	if err == nil {
		t.Error("expected error for localhost")
	}
}
