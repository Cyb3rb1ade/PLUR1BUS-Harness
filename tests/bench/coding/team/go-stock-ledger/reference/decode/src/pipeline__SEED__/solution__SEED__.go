// SPDX-License-Identifier: MIT
// Authored task endpoint and domain implementation; this public tree contains no hidden oracle.
package solution

import contract "fixture.local/task/src/contracts__SEED__"

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

func implDecode(raw string) string {
	if raw == "" {
		return ""
	}
	result := []string{}
	valid := regexp.MustCompile(`^[A-Za-z0-9_]+$`)
	for _, token := range strings.Split(raw, ";") {
		fields := strings.Fields(token)
		if len(fields) != 3 || !valid.MatchString(fields[1]) {
			return "error"
		}
		n, err := strconv.Atoi(fields[2])
		if err != nil || n <= 0 {
			return "error"
		}
		code := ""
		switch fields[0] {
		case "ADD":
			code = "A"
		case "RESERVE":
			code = "R"
		default:
			return "error"
		}
		result = append(result, fmt.Sprintf("%s,%s,%d", code, fields[1], n))
	}
	return strings.Join(result, ";")
}

func implApply(raw string) string { return "unimplemented" }

func implRender(raw string) string { return "unimplemented" }

// Decode__SEED__ validates the public frame and actual predecessor state before domain processing.
func Decode__SEED__(raw string) contract.Packet {
	value, ok := contract.Text(raw)
	result := "error"
	if ok && value != "error" {
		result = implDecode(value)
	}
	return contract.PacketOf(result, 1)
}

// Apply__SEED__ validates the public frame and actual predecessor state before domain processing.
func Apply__SEED__(raw contract.Packet) contract.Packet {
	value, ok := contract.Payload(raw, 1)
	if ok {
		value, ok = contract.Text(value)
	}
	result := "error"
	if ok && value != "error" {
		result = implApply(value)
	}
	return contract.PacketOf(result, 2)
}

// Render__SEED__ validates the public frame and actual predecessor state before domain processing.
func Render__SEED__(raw contract.Packet) string {
	value, ok := contract.Payload(raw, 2)
	if ok {
		value, ok = contract.Text(value)
	}
	result := "error"
	if ok && value != "error" {
		result = implRender(value)
	}
	return result
}
