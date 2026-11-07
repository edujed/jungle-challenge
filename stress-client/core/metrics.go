package core

import (
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// Metrics collects atomic counters and latency percentiles for a table run.
type Metrics struct {
	totalRequests atomic.Int64
	success       atomic.Int64
	errors        atomic.Int64
	duplicates    atomic.Int64
	rejections    atomic.Int64
	pendingRef    atomic.Int64
	conflicts     atomic.Int64

	mu        sync.Mutex
	latencies []time.Duration
}

// NewMetrics creates a new Metrics collector.
func NewMetrics() *Metrics {
	return &Metrics{}
}

// Record records a single request outcome.
func (m *Metrics) Record(latency time.Duration, category RequestCategory) {
	m.totalRequests.Add(1)
	m.mu.Lock()
	m.latencies = append(m.latencies, latency)
	m.mu.Unlock()

	switch category {
	case CatSuccess:
		m.success.Add(1)
	case CatError:
		m.errors.Add(1)
	case CatDuplicate:
		m.duplicates.Add(1)
	case CatRejection:
		m.rejections.Add(1)
	case CatPendingRef:
		m.pendingRef.Add(1)
	case CatConflict:
		m.conflicts.Add(1)
	}
}

// Snapshot returns a copy of the current metrics.
func (m *Metrics) Snapshot() MetricsSnapshot {
	m.mu.Lock()
	latencies := make([]time.Duration, len(m.latencies))
	copy(latencies, m.latencies)
	m.mu.Unlock()

	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })

	return MetricsSnapshot{
		TotalRequests: m.totalRequests.Load(),
		Success:       m.success.Load(),
		Errors:        m.errors.Load(),
		Duplicates:    m.duplicates.Load(),
		Rejections:    m.rejections.Load(),
		PendingRef:    m.pendingRef.Load(),
		Conflicts:     m.conflicts.Load(),
		P50:           percentile(latencies, 50),
		P95:           percentile(latencies, 95),
		P99:           percentile(latencies, 99),
	}
}

// MetricsSnapshot is an immutable copy of metrics at a point in time.
type MetricsSnapshot struct {
	TotalRequests int64
	Success       int64
	Errors        int64
	Duplicates    int64
	Rejections    int64
	PendingRef    int64
	Conflicts     int64
	P50           time.Duration
	P95           time.Duration
	P99           time.Duration
}

// RequestCategory classifies a request outcome for metrics.
type RequestCategory int

const (
	CatSuccess RequestCategory = iota
	CatError
	CatDuplicate
	CatRejection
	CatPendingRef
	CatConflict
)

func percentile(sorted []time.Duration, p int) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	idx := p * len(sorted) / 100
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}
