// SPDX-License-Identifier: MIT
package solution

import (
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"
)

func Solve(raw string) string {
	type row struct {
		name string
		size int
	}
	rows := []row{}
	if raw == "" {
		return ""
	}
	for _, token := range strings.Split(raw, ";") {
		pair := strings.Split(token, ":")
		if len(pair) != 2 || strings.Contains(pair[0], "\\") || strings.HasPrefix(pair[0], "/") {
			return "error"
		}
		clean := path.Clean(pair[0])
		size, err := strconv.Atoi(pair[1])
		if err != nil || size < 0 || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
			return "error"
		}
		rows = append(rows, row{clean, size})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].name == rows[j].name {
			return rows[i].size < rows[j].size
		}
		return rows[i].name < rows[j].name
	})
	result := []string{}
	for _, r := range rows {
		result = append(result, fmt.Sprintf("%s:%d", r.name, r.size))
	}
	return strings.Join(result, ";")
}
