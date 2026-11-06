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
	total, errors := 0, 0
	seen := map[string]bool{}
	if raw != "" {
		for _, token := range strings.Split(raw, ";") {
			pair := strings.Split(token, ":")
			if len(pair) != 2 || len(pair[0]) != 3 || pair[0][1:] != "xx" || pair[0][0] < '1' || pair[0][0] > '5' || seen[pair[0]] {
				return "error"
			}
			count, err := strconv.Atoi(pair[1])
			if err != nil || count <= 0 {
				return "error"
			}
			seen[pair[0]] = true
			total += count
			if pair[0][0] >= '4' {
				errors += count
			}
		}
	}
	return fmt.Sprintf("requests=%d;errors=%d", total, errors)
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
