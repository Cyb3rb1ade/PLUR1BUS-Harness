// Original MIT benchmark fixture; the generated README states the contract.
package benchmark

import "strings"

func BENCH_FN(root map[string]any, path string) (any, bool) {
	parts := strings.Split(path, ".")
	var current any = root
	for index, part := range parts {
		if part == "" {
			return nil, false
		}
		object, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		value, exists := object[part]
		if !exists {
			return nil, false
		}
		if index == len(parts)-1 {
			return value, true
		}
		current = value
	}
	return nil, false
}
