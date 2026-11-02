// SPDX-License-Identifier: MIT
// Authored task endpoint and domain implementation; this public tree contains no hidden oracle.
package solution

import contract "fixture.local/task/src/contracts__SEED__"

import (
	"strconv"
	"strings"
)

func implSolve(raw string) string {
	if raw == "" {
		return ""
	}
	result := []string{}
	elapsed := 0
	excluded := false
	for _, part := range strings.Split(raw, ",") {
		value, err := strconv.Atoi(part)
		if err != nil || value < 1 || value > 1000000000 {
			return "error"
		}
		if excluded || value > 150-elapsed {
			excluded = true
			continue
		}
		elapsed += value
		result = append(result, strconv.Itoa(value))
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
