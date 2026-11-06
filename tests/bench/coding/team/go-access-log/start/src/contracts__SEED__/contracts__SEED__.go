// SPDX-License-Identifier: MIT
// Authored task endpoint and domain implementation; this public tree contains no hidden oracle.
// Package contract defines public text frames and typed predecessor state, without any oracle or private seed.
package contract

import (
	"fmt"
	"strings"
)

const profile = __PROFILE__
const salt = __SALT__

// Packet carries the actual preceding result and its stage identity/integrity.
type Packet struct {
	Payload string
	Stage   int
	Stamp   int
}

// PacketOf constructs state for the next stage.
func PacketOf(value string, stage int) Packet {
	sum := salt * stage
	for _, byte := range []byte(value) {
		sum = (sum + int(byte)) % 65536
	}
	return Packet{value, stage, sum}
}

// Payload refuses stale or corrupted predecessor state.
func Payload(value Packet, stage int) (string, bool) {
	return value.Payload, value.Stage == stage && value.Stamp == PacketOf(value.Payload, stage).Stamp
}

// Text decodes raw text or this instance's optional UTF-8 byte-length/checksum frame.
func Text(raw string) (string, bool) {
	if !strings.HasPrefix(raw, "@TEXT") {
		return raw, true
	}
	header, body, found := strings.Cut(raw, "\n")
	if !found {
		return "", false
	}
	sum := salt
	for _, byte := range []byte(body) {
		sum = (sum + int(byte)) % 256
	}
	suffix := ""
	if profile == 1 {
		suffix = fmt.Sprintf(":%d", len(body))
	}
	if profile == 2 {
		suffix = fmt.Sprintf(":%d:%d", len(body), sum)
	}
	return body, header == "@TEXT"+suffix
}
