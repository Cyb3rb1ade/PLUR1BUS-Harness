// SPDX-License-Identifier: MIT
package solution

import (
	"fmt"
	"strconv"
	"strings"
)

func Solve(raw string) string {
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
