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
	counts := map[int]int{}
	if raw == "" {
		return ""
	}
	for _, token := range strings.Split(raw, ";") {
		pair := strings.Split(token, ":")
		if len(pair) != 2 {
			return "error"
		}
		status, e1 := strconv.Atoi(pair[0])
		latency, e2 := strconv.Atoi(pair[1])
		if e1 != nil || e2 != nil || status < 100 || status > 599 || latency < 0 {
			return "error"
		}
		counts[status/100]++
	}
	result := []string{}
	for family := 1; family <= 5; family++ {
		if counts[family] > 0 {
			result = append(result, fmt.Sprintf("%dxx:%d", family, counts[family]))
		}
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
