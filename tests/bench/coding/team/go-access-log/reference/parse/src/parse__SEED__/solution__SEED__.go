// SPDX-License-Identifier: MIT
// Authored task endpoint and domain implementation; this public tree contains no hidden oracle.
package solution

import contract "fixture.local/task/src/contracts__SEED__"

import (
	"fmt"
	"strconv"
	"strings"
)

func implSolve(raw string) string {
	result := []string{}
	for _, line := range strings.Split(raw, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if len(fields) != 4 || !strings.HasPrefix(fields[1], "/") {
			return "error"
		}
		switch fields[0] {
		case "GET", "POST", "PUT", "DELETE":
		default:
			return "error"
		}
		status, e1 := strconv.Atoi(fields[2])
		latency, e2 := strconv.Atoi(fields[3])
		if e1 != nil || e2 != nil || status < 100 || status > 599 || latency < 0 {
			return "error"
		}
		result = append(result, fmt.Sprintf("%d:%d", status, latency))
	}
	return strings.Join(result, ";")
}

// Solve__SEED__ validates the public frame and actual predecessor state before domain processing.
func Solve__SEED__(raw string) string {
	value, ok := contract.Text(raw)
	result := "error"
	if ok && value != "error" {
		result = implSolve(value)
	}
	return result
}
