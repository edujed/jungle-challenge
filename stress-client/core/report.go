package core

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
)

// WriteReport writes a JSON report with the table result and invariant
// outcomes to the given path.
func WriteReport(path string, result *TableResult, invariants []InvariantResult) error {
	data := map[string]any{
		"table":      result,
		"invariants": invariants,
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", "  ")
	if err := enc.Encode(data); err != nil {
		return fmt.Errorf("encode report: %w", err)
	}
	return os.WriteFile(path, buf.Bytes(), 0644)
}
