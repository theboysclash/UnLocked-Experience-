package wisp

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	PacketConnect  byte = 0x01
	PacketData     byte = 0x02
	PacketContinue byte = 0x03
	PacketClose    byte = 0x04
	PacketInfo     byte = 0x05

	StreamTCP byte = 0x01
	StreamUDP byte = 0x02

	ReasonUnknown                byte = 0x01
	ReasonVoluntary              byte = 0x02
	ReasonNetworkError           byte = 0x03
	ReasonIncompatibleExtensions byte = 0x04

	ReasonInvalidInfo      byte = 0x41
	ReasonUnreachableHost  byte = 0x42
	ReasonNoResponse       byte = 0x43
	ReasonConnRefused      byte = 0x44
	ReasonTransferTimeout  byte = 0x47
	ReasonHostBlocked      byte = 0x48
	ReasonConnThrottled    byte = 0x49
)

var (
	ErrPacketTooShort = errors.New("wisp packet too short")
	ErrInvalidPacket  = errors.New("invalid wisp packet")
)

// Packet represents a parsed Wisp protocol packet
type Packet struct {
	Type     byte
	StreamID uint32
	Payload  []byte
}

// ParsePacket parses a raw byte slice into a Packet
func ParsePacket(data []byte) (*Packet, error) {
	if len(data) < 5 {
		return nil, ErrPacketTooShort
	}
	pktType := data[0]
	streamID := binary.LittleEndian.Uint32(data[1:5])
	payload := data[5:]

	return &Packet{
		Type:     pktType,
		StreamID: streamID,
		Payload:  payload,
	}, nil
}

// Serialize serializes a packet into a byte slice
func (p *Packet) Serialize() []byte {
	buf := make([]byte, 5+len(p.Payload))
	buf[0] = p.Type
	binary.LittleEndian.PutUint32(buf[1:5], p.StreamID)
	copy(buf[5:], p.Payload)
	return buf
}

// BuildContinuePacket creates a CONTINUE packet
func BuildContinuePacket(streamID uint32, bufferRemaining uint32) []byte {
	buf := make([]byte, 9)
	buf[0] = PacketContinue
	binary.LittleEndian.PutUint32(buf[1:5], streamID)
	binary.LittleEndian.PutUint32(buf[5:9], bufferRemaining)
	return buf
}

// BuildClosePacket creates a CLOSE packet
func BuildClosePacket(streamID uint32, reason byte) []byte {
	buf := make([]byte, 6)
	buf[0] = PacketClose
	binary.LittleEndian.PutUint32(buf[1:5], streamID)
	buf[5] = reason
	return buf
}

// BuildDataPacket creates a DATA packet
func BuildDataPacket(streamID uint32, payload []byte) []byte {
	buf := make([]byte, 5+len(payload))
	buf[0] = PacketData
	binary.LittleEndian.PutUint32(buf[1:5], streamID)
	copy(buf[5:], payload)
	return buf
}

// BuildInfoPacket creates an INFO packet for Wisp v2
func BuildInfoPacket(major, minor byte, extensions []byte) []byte {
	buf := make([]byte, 7+len(extensions))
	buf[0] = PacketInfo
	binary.LittleEndian.PutUint32(buf[1:5], 0) // stream 0
	buf[5] = major
	buf[6] = minor
	copy(buf[7:], extensions)
	return buf
}

// ConnectPayload represents parsed data from a CONNECT packet
type ConnectPayload struct {
	StreamType byte
	Port       uint16
	Hostname   string
}

// ParseConnectPayload parses the payload of a CONNECT packet
func ParseConnectPayload(payload []byte) (*ConnectPayload, error) {
	if len(payload) < 3 {
		return nil, fmt.Errorf("%w: connect payload too short", ErrInvalidPacket)
	}
	streamType := payload[0]
	port := binary.LittleEndian.Uint16(payload[1:3])
	hostname := string(payload[3:])

	return &ConnectPayload{
		StreamType: streamType,
		Port:       port,
		Hostname:   hostname,
	}, nil
}
