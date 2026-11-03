// SPDX-License-Identifier: MIT
// Authored task endpoint and domain implementation; this public tree contains no hidden oracle.
package solution

import contract "fixture.local/task/src/contracts__SEED__"

import (
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"
)

func implSolve(raw string) string {
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

// Solve__SEED__ validates the public frame and actual predecessor state before domain processing.
func Solve__SEED__(raw string) string {
	value, ok := contract.Text(raw)
	result := "error"
	if ok && value != "error" {
		result = implSolve(value)
	}
	return result
}
