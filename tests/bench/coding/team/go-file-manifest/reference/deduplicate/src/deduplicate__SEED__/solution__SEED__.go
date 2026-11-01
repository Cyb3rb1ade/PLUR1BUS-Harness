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
