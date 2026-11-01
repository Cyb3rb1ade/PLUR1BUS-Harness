// Original MIT benchmark fixture; the generated README states the contract.
package main

import (
	"io"
	"os"
	"strconv"
	"unicode/utf8"
)

func main() {
	if len(os.Args) != 2 || os.Args[1] == "" {
		os.Exit(2)
	}
	for _, digit := range os.Args[1] {
		if digit < '0' || digit > '9' {
			os.Exit(2)
		}
	}
	data, err := io.ReadAll(os.Stdin)
	if err != nil || !utf8.Valid(data) {
		os.Exit(2)
	}
	limit, err := strconv.Atoi(os.Args[1])
	if err != nil || limit > len(data) {
		limit = len(data)
	}
	if limit < len(data) {
		for limit > 0 && data[limit]&0xc0 == 0x80 {
			limit--
		}
	}
	if _, err = os.Stdout.Write(data[:limit]); err != nil {
		os.Exit(2)
	}
}
