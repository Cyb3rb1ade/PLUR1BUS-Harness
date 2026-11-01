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
	sizes := map[string]int{}
	if raw == "" {
		return ""
	}
	for _, token := range strings.Split(raw, ";") {
		pair := strings.Split(token, ":")
		if len(pair) != 2 || path.Clean(pair[0]) != pair[0] || pair[0] == "." || pair[0] == ".." || strings.HasPrefix(pair[0], "/") || strings.HasPrefix(pair[0], "../") || strings.Contains(pair[0], "\\") {
			return "error"
		}
		size, err := strconv.Atoi(pair[1])
		if err != nil || size < 0 {
			return "error"
		}
		old, ok := sizes[pair[0]]
		if !ok || size > old {
			sizes[pair[0]] = size
		}
	}
	names := []string{}
	for name := range sizes {
		names = append(names, name)
	}
	sort.Strings(names)
	result := []string{}
	for _, name := range names {
		result = append(result, fmt.Sprintf("%s:%d", name, sizes[name]))
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
