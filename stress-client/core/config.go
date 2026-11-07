package core

import "time"

// Config holds the common configuration shared by all table clients.
type Config struct {
	// BaseURLs is a comma-separated list of backend base URLs.
	// The orchestrator distributes load round-robin across them.
	BaseURLs []string

	// SQSEndpoint is the SQS endpoint (LocalStack/MiniStack).
	SQSEndpoint string

	// SQSQueue is the FIFO queue name.
	SQSQueue string

	// Duration is the total load duration.
	Duration time.Duration

	// ReportPath is where the JSON report is written.
	ReportPath string

	// LogFile is where the log file is written (empty = stdout only).
	LogFile string

	// LogLevel controls the minimum log level (debug, info, warn, error).
	LogLevel LogLevel

	// Verbose enables per-table detailed logging.
	Verbose bool

	// AuthToken is the Bearer token sent on every HTTP request.
	// Empty = DefaultAuthToken (works with the backend's NoopTokenValidator
	// when AUTH_ENABLED=false).
	AuthToken string
}

// ParseBaseURLs splits a comma-separated string into a slice of URLs.
func ParseBaseURLs(s string) []string {
	var urls []string
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ',' {
			url := s[start:i]
			if len(url) > 0 {
				urls = append(urls, url)
			}
			start = i + 1
		}
	}
	return urls
}
