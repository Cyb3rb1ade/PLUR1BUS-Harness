// Original MIT benchmark fixture; the generated README states the contract.
package benchmark

type Record struct {
	Name  string `json:"name"`
	Value int64  `json:"value"`
}

func BENCH_FN(chunks [][]byte, limit int) ([]Record, error) { return []Record{}, nil }
