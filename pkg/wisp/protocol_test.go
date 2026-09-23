package wisp

import (
	"bytes"
	"testing"
)

func TestPacketSerialization(t *testing.T) {
	pkt := &Packet{
		Type:     PacketData,
		StreamID: 42,
		Payload:  []byte("hello world"),
	}

	serialized := pkt.Serialize()
	parsed, err := ParsePacket(serialized)
	if err != nil {
		t.Fatalf("ParsePacket failed: %v", err)
	}

	if parsed.Type != pkt.Type {
		t.Errorf("got type %d, want %d", parsed.Type, pkt.Type)
	}
	if parsed.StreamID != pkt.StreamID {
		t.Errorf("got streamID %d, want %d", parsed.StreamID, pkt.StreamID)
	}
	if !bytes.Equal(parsed.Payload, pkt.Payload) {
		t.Errorf("got payload %s, want %s", string(parsed.Payload), string(pkt.Payload))
	}
}

func TestConnectPayload(t *testing.T) {
	connPayload := &ConnectPayload{
		StreamType: StreamTCP,
		Port:       443,
		Hostname:   "example.com",
	}

	buf := make([]byte, 3+len(connPayload.Hostname))
	buf[0] = connPayload.StreamType
	buf[1] = byte(connPayload.Port)
	buf[2] = byte(connPayload.Port >> 8)
	copy(buf[3:], connPayload.Hostname)

	parsed, err := ParseConnectPayload(buf)
	if err != nil {
		t.Fatalf("ParseConnectPayload failed: %v", err)
	}

	if parsed.StreamType != connPayload.StreamType {
		t.Errorf("got type %d, want %d", parsed.StreamType, connPayload.StreamType)
	}
	if parsed.Port != connPayload.Port {
		t.Errorf("got port %d, want %d", parsed.Port, connPayload.Port)
	}
	if parsed.Hostname != connPayload.Hostname {
		t.Errorf("got hostname %s, want %s", parsed.Hostname, connPayload.Hostname)
	}
}
