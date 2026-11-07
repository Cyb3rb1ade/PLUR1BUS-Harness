// Original MIT benchmark fixture; the generated README states the contract.
package benchmark

func BENCH_FN(root map[string]any, path string) (any, bool) {
	value, exists := root[path]
	return value, exists
}
