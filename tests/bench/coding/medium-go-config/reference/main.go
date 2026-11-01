// Original MIT benchmark fixture; the generated README states the contract.
package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"unicode/utf8"
)

func normalize(data []byte) (map[string]any, bool) {
	if !utf8.Valid(data) {
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return nil, false
	}
	port, flags := BENCH_CONST, []string{}
	seen := make(map[string]bool)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, false
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return nil, false
		}
		seen[key] = true
		var raw json.RawMessage
		if decoder.Decode(&raw) != nil {
			return nil, false
		}
		switch key {
		case "port":
			if json.Unmarshal(raw, &port) != nil || port < 1 || port > 65535 || bytes.Equal(raw, []byte("null")) {
				return nil, false
			}
		case "flags":
			var values []*string
			if json.Unmarshal(raw, &values) != nil || values == nil {
				return nil, false
			}
			flags = []string{}
			for _, value := range values {
				if value == nil {
					return nil, false
				}
				flags = append(flags, *value)
			}
		default:
			return nil, false
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return nil, false
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return nil, false
	}
	result, unique := []string{}, make(map[string]bool)
	for _, flag := range flags {
		flag = strings.TrimSpace(flag)
		if flag != "" && !unique[flag] {
			result = append(result, flag)
			unique[flag] = true
		}
	}
	return map[string]any{"port": port, "flags": result}, true
}
func main() {
	data, err := io.ReadAll(os.Stdin)
	result, valid := normalize(data)
	if err != nil || !valid {
		os.Exit(2)
	}
	if json.NewEncoder(os.Stdout).Encode(result) != nil {
		os.Exit(2)
	}
}
