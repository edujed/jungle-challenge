package core

import (
	"sort"
	"sync"
)

// InstanceTracker counts HTTP responses per backend instance, based on the
// X-Instance-Id response header set by the backend (ADR-011). It is shared
// across all tables so the orchestrator can report the global distribution.
type InstanceTracker struct {
	mu      sync.Mutex
	counts  map[string]int64
	byTable map[string]map[string]int64
}

// NewInstanceTracker creates an empty tracker.
func NewInstanceTracker() *InstanceTracker {
	return &InstanceTracker{
		counts:  make(map[string]int64),
		byTable: make(map[string]map[string]int64),
	}
}

// Record increments the counter for the given instance ID (and table).
// An empty instance ID is recorded under "(unknown)".
func (t *InstanceTracker) Record(table, instanceID string) {
	if instanceID == "" {
		instanceID = "(unknown)"
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.counts[instanceID]++
	m := t.byTable[table]
	if m == nil {
		m = make(map[string]int64)
		t.byTable[table] = m
	}
	m[instanceID]++
}

// Snapshot returns a sorted map of instance ID → total count.
func (t *InstanceTracker) Snapshot() map[string]int64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make(map[string]int64, len(t.counts))
	for k, v := range t.counts {
		out[k] = v
	}
	return out
}

// SnapshotForTable returns a sorted map of instance ID → count for one table.
func (t *InstanceTracker) SnapshotForTable(table string) map[string]int64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	src := t.byTable[table]
	out := make(map[string]int64, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}

// SortedKeys returns the instance IDs sorted alphabetically.
func (t *InstanceTracker) SortedKeys() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	keys := make([]string, 0, len(t.counts))
	for k := range t.counts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
