// Original MIT benchmark fixture; the generated README states the contract.
package benchmark

func BENCH_FN(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]bool)
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}
