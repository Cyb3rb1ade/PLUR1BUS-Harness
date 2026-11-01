// SPDX-License-Identifier: MIT
package solution

import (
	"fmt"
	"regexp"
	"sort"
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

func Apply(raw string) string {
	stock := map[string]int{}
	valid := regexp.MustCompile(`^[A-Za-z0-9_]+$`)
	if raw != "" {
		for _, token := range strings.Split(raw, ";") {
			fields := strings.Split(token, ",")
			if len(fields) != 3 || !valid.MatchString(fields[1]) || (fields[0] != "A" && fields[0] != "R") {
				return "error"
			}
			n, err := strconv.Atoi(fields[2])
			if err != nil || n <= 0 {
				return "error"
			}
			if fields[0] == "A" {
				stock[fields[1]] += n
			} else if stock[fields[1]] >= n {
				stock[fields[1]] -= n
			}
		}
	}
	names := []string{}
	for name := range stock {
		names = append(names, name)
	}
	sort.Strings(names)
	result := []string{}
	for _, name := range names {
		result = append(result, fmt.Sprintf("%s:%d", name, stock[name]))
	}
	return strings.Join(result, ";")
}

func Render(raw string) string { return "unimplemented" }
