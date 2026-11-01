// Original MIT benchmark fixture; the generated README states the contract.
package benchmark

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"unicode/utf8"
)

type Record struct {
	Name  string `json:"name"`
	Value int64  `json:"value"`
}

func parseRecord(line []byte) (Record, error) {
	var result Record
	if !utf8.Valid(line) {
		return result, errors.New("invalid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(line))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return result, errors.New("expected object")
	}
	seen := make(map[string]bool)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return result, err
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return result, errors.New("duplicate key")
		}
		seen[key] = true
		switch key {
		case "name":
			var name *string
			if decoder.Decode(&name) != nil || name == nil || *name == "" {
				return result, errors.New("invalid name")
			}
			result.Name = *name
		case "value":
			var raw json.RawMessage
			if decoder.Decode(&raw) != nil {
				return result, errors.New("invalid value")
			}
			value, err := strconv.ParseInt(string(raw), 10, 64)
			if err != nil {
				return result, err
			}
			result.Value = value
		default:
			return result, errors.New("unknown field")
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') || !seen["name"] || !seen["value"] {
		return result, errors.New("missing fields")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return result, errors.New("trailing value")
	}
	return result, nil
}
func BENCH_FN(chunks [][]byte, limit int) ([]Record, error) {
	if limit <= 0 {
		return nil, errors.New("invalid limit")
	}
	records, pending := make([]Record, 0), make([]byte, 0)
	flush := func() error {
		line := pending
		if len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		if len(line) > limit {
			return errors.New("line too long")
		}
		if len(line) > 0 {
			record, err := parseRecord(line)
			if err != nil {
				return err
			}
			records = append(records, record)
		}
		pending = pending[:0]
		return nil
	}
	for _, chunk := range chunks {
		for _, value := range chunk {
			if value == '\n' {
				if err := flush(); err != nil {
					return nil, err
				}
			} else {
				if len(pending) > limit {
					return nil, errors.New("line too long")
				}
				pending = append(pending, value)
			}
		}
	}
	if len(pending) > 0 {
		if err := flush(); err != nil {
			return nil, err
		}
	}
	return records, nil
}
