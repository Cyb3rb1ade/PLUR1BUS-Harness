// SPDX-License-Identifier: MIT
package solution

import (
	"fmt"
	"strconv"
	"strings"
)

func Solve(raw string) string {
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
