// SPDX-License-Identifier: MIT
// Authored task endpoint and domain implementation; this public tree contains no hidden oracle.
package solution

import contract "fixture.local/task/src/contracts__SEED__"

import (
	"strconv"
	"strings"
)

func implSolve(raw string) string {
	parts := strings.Split(raw, ",")
	if len(parts) != 3 {
		return "error"
	}
	base, e1 := strconv.Atoi(parts[0])
	cap, e2 := strconv.Atoi(parts[1])
	attempts, e3 := strconv.Atoi(parts[2])
	if e1 != nil || e2 != nil || e3 != nil || base < 1 || base > 1000000 || cap < base || cap > 1000000000 || attempts < 0 || attempts > 100 {
		return "error"
	}
	result := []string{}
	delay := base
	for i := 0; i < attempts; i++ {
		result = append(result, strconv.Itoa(delay))
		if delay > cap/2 {
			delay = cap
		} else {
			delay *= 2
		}
	}
	return strings.Join(result, ",")
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
