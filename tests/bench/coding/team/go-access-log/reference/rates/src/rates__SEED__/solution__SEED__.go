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
	parts := strings.Split(raw, ";")
	if len(parts) != 2 || !strings.HasPrefix(parts[0], "requests=") || !strings.HasPrefix(parts[1], "errors=") {
		return "error"
	}
	total, e1 := strconv.Atoi(strings.TrimPrefix(parts[0], "requests="))
	errors, e2 := strconv.Atoi(strings.TrimPrefix(parts[1], "errors="))
	if e1 != nil || e2 != nil || total < 0 || errors < 0 || errors > total {
		return "error"
	}
	percent := 0
	if total > 0 {
		percent = errors * 100 / total
	}
	return fmt.Sprintf("requests=%d;errors=%d;errorPercent=%d", total, errors, percent)
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
