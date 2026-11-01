// SPDX-License-Identifier: MIT
package solution

import (
	"strconv"
	"strings"
)

func Solve(raw string) string {
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
