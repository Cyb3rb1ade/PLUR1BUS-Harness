// SPDX-License-Identifier: MIT
package solution

import (
	"fmt"
	"strconv"
	"strings"
)

func Solve(raw string) string {
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
