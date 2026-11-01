// SPDX-License-Identifier: MIT
package solution

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

func Decode(raw string) string {
	if raw == "" {
		return ""
	}
	result := []string{}
	valid := regexp.MustCompile(`^[A-Za-z0-9_]+$`)
	for _, token := range strings.Split(raw, ";") {
		fields := strings.Fields(token)
		if len(fields) != 3 || !valid.MatchString(fields[1]) {
			return "error"
		}
		n, err := strconv.Atoi(fields[2])
		if err != nil || n <= 0 {
			return "error"
		}
		code := ""
		switch fields[0] {
		case "ADD":
			code = "A"
		case "RESERVE":
			code = "R"
		default:
			return "error"
		}
		result = append(result, fmt.Sprintf("%s,%s,%d", code, fields[1], n))
	}
	return strings.Join(result, ";")
}

func Apply(raw string) string { return "unimplemented" }

func Render(raw string) string { return "unimplemented" }
