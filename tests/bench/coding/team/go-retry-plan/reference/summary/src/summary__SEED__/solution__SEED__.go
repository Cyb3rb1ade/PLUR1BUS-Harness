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
	elapsed, count := 0, 0
	if raw != "" {
		for _, part := range strings.Split(raw, ",") {
			value, err := strconv.Atoi(part)
			if err != nil || value <= 0 || value > 1000000000 {
				return "error"
			}
			elapsed += value
			count++
		}
	}
	return fmt.Sprintf("attempts=%d;elapsed=%d", count, elapsed)
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
