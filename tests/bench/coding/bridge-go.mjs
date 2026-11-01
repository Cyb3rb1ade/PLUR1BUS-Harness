/** Original MIT Go test-binary shims. No expected output or reference algorithm is embedded. */
export function goBridge(id, symbol) {
  const header = (imports) => `// Original MIT B1 invocation shim; no expected results.
package benchmark
import ("encoding/json"; "os"; "testing"; ${imports})
func TestCodingPrivateBridge(t *testing.T) {
`;
  if (id === "easy-go-unique")
    return (
      header('"bytes"') +
      `
    var input struct { Values []string }
    if json.NewDecoder(os.Stdin).Decode(&input) != nil { t.Fatal("bridge input") }
    values := input.Values
    var backing []string
    if values != nil {
        backing = make([]string, len(values)+1); copy(backing, values)
        backing[len(values)] = "coding sentinel"; values = backing[:len(values)]
    }
    before, _ := json.Marshal(backing)
    result := ${symbol}(values)
    after, _ := json.Marshal(backing)
    json.NewEncoder(os.Stdout).Encode(map[string]any{"value":result,"nonNil":result!=nil,"unchanged":bytes.Equal(before,after)})
}
`
    );
  if (id === "easy-go-lookup")
    return (
      header('"bytes"') +
      `
    var input struct { Root map[string]any; Path string }
    if json.NewDecoder(os.Stdin).Decode(&input) != nil { t.Fatal("bridge input") }
    before, _ := json.Marshal(input.Root)
    value, exists := ${symbol}(input.Root, input.Path)
    after, _ := json.Marshal(input.Root)
    json.NewEncoder(os.Stdout).Encode(map[string]any{"value":value,"exists":exists,"unchanged":bytes.Equal(before,after)})
}
`
    );
  if (id === "hard-go-ndjson")
    return (
      header('"encoding/base64"; "strconv"') +
      `
    var input struct { Chunks []string; Limit int }
    if json.NewDecoder(os.Stdin).Decode(&input) != nil { t.Fatal("bridge input") }
    chunks := make([][]byte,len(input.Chunks))
    for index, chunk := range input.Chunks {
        var err error; chunks[index],err = base64.StdEncoding.DecodeString(chunk)
        if err != nil { t.Fatal("bridge encoding") }
    }
    records, err := ${symbol}(chunks,input.Limit)
    if err != nil {
        json.NewEncoder(os.Stdout).Encode(map[string]any{"error":true,"nil":records==nil}); return
    }
    values := make([]map[string]string,0,len(records))
    for _, record := range records { values=append(values,map[string]string{"name":record.Name,"value":strconv.FormatInt(record.Value,10)}) }
    json.NewEncoder(os.Stdout).Encode(map[string]any{"value":values,"nonNil":records!=nil})
}
`
    );
  throw new Error("unsupported Go bridge");
}
