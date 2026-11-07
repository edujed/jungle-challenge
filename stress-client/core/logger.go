package core

import (
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// LogLevel controls the verbosity of log output.
type LogLevel int

const (
	LogDebug LogLevel = iota
	LogInfo
	LogWarn
	LogError
)

func (l LogLevel) String() string {
	switch l {
	case LogDebug:
		return "DEBUG"
	case LogInfo:
		return "INFO"
	case LogWarn:
		return "WARN"
	case LogError:
		return "ERROR"
	default:
		return "UNKNOWN"
	}
}

// Logger is a thread-safe structured logger that writes to multiple
// destinations (stdout + optional file).
type Logger struct {
	mu      sync.Mutex
	writers []io.Writer
	level   LogLevel
}

// NewLogger creates a logger that writes to stdout and optionally to a file.
// If filePath is non-empty, logs are also appended to that file.
func NewLogger(filePath string, level LogLevel) (*Logger, error) {
	l := &Logger{
		level: level,
	}

	// Always write to stdout
	l.writers = append(l.writers, os.Stdout)

	// Optionally write to file
	if filePath != "" {
		f, err := os.OpenFile(filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			return nil, fmt.Errorf("open log file %s: %w", filePath, err)
		}
		l.writers = append(l.writers, f)
	}

	return l, nil
}

// Close closes any file writers.
func (l *Logger) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, w := range l.writers {
		if f, ok := w.(*os.File); ok {
			f.Close()
		}
	}
}

// SetLevel changes the minimum log level.
func (l *Logger) SetLevel(level LogLevel) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.level = level
}

// Logf writes a formatted log message at the given level.
func (l *Logger) Logf(level LogLevel, format string, args ...any) {
	if level < l.level {
		return
	}

	ts := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	msg := fmt.Sprintf("%s [%s] %s\n", ts, level.String(), fmt.Sprintf(format, args...))

	l.mu.Lock()
	defer l.mu.Unlock()
	for _, w := range l.writers {
		w.Write([]byte(msg))
	}
}

// Debugf logs at DEBUG level.
func (l *Logger) Debugf(format string, args ...any) {
	l.Logf(LogDebug, format, args...)
}

// Infof logs at INFO level.
func (l *Logger) Infof(format string, args ...any) {
	l.Logf(LogInfo, format, args...)
}

// Warnf logs at WARN level.
func (l *Logger) Warnf(format string, args ...any) {
	l.Logf(LogWarn, format, args...)
}

// Errorf logs at ERROR level.
func (l *Logger) Errorf(format string, args ...any) {
	l.Logf(LogError, format, args...)
}
