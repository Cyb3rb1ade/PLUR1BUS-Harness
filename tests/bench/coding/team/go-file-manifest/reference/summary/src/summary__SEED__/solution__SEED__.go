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
	total, count := 0, 0
	seen := map[string]bool{}
	if raw != "" {
		for _, token := range strings.Split(raw, ";") {
			pair := strings.Split(token, ":")
			if len(pair) != 2 || pair[0] == "" || seen[pair[0]] {
				return "error"
			}
			size, err := strconv.Atoi(pair[1])
			if err != nil || size < 0 {
				return "error"
			}
			seen[pair[0]] = true
			total += size
			count++
		}
	}
	return fmt.Sprintf("files=%d;bytes=%d", count, total)
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
