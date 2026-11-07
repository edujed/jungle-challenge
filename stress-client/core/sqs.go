package core

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// SQSProducer sends messages to an SQS FIFO queue.
type SQSProducer struct {
	client   *sqs.Client
	queueURL string
	log      *Logger

	// Rate limiter: token bucket to avoid overwhelming LocalStack's SQS
	// (which has a much lower throughput than real AWS SQS). Without this,
	// the client triggers "failed to get rate limit token, retry quota
	// exceeded" errors under high concurrency.
	rateLimiter *rateLimiter

	// SendFailures counts SendMessage calls that failed after all retries.
	// These are NOT duplicates — they are messages that never reached the
	// queue. Tracked separately from HTTP 409 conflicts.
	SendFailures atomic.Int64
}

// SetRateLimit sets the maximum SQS SendMessage rate (messages per second).
// Call before sending. 0 or negative disables the limiter.
func (p *SQSProducer) SetRateLimit(rps int) {
	if rps > 0 {
		p.rateLimiter = newRateLimiter(rps)
	}
}

// SetLogger attaches a logger to the SQS producer.
func (p *SQSProducer) SetLogger(l *Logger) {
	p.log = l
}

func (p *SQSProducer) logf(level LogLevel, format string, args ...any) {
	if p.log != nil {
		p.log.Logf(level, format, args...)
	}
}

// NewSQSProducer creates an SQSProducer for the given endpoint and queue name.
// For LocalStack/MiniStack, use static credentials and the local endpoint.
func NewSQSProducer(ctx context.Context, endpoint, queueName string) (*SQSProducer, error) {
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion("us-east-1"),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("test", "test", "")),
	)
	if err != nil {
		return nil, fmt.Errorf("load AWS config: %w", err)
	}

	// Connection pooling: limita conexões simultâneas ao LocalStack para evitar
	// esgotamento de portas efêmeras no host (mesmo problema do HTTP client).
	// Sem isso, ~3000 goroutines × rajadas de SendMessage criam milhares de
	// conexões TCP novas ao :4566, esgotando o range 32768-60999 (28k portas).
	sqsTransport := &http.Transport{
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   50,
		MaxConnsPerHost:       200,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}

	client := sqs.NewFromConfig(cfg, func(o *sqs.Options) {
		o.BaseEndpoint = aws.String(endpoint)
		o.HTTPClient = &http.Client{Transport: sqsTransport}
	})

	// Resolve queue URL
	result, err := client.GetQueueUrl(ctx, &sqs.GetQueueUrlInput{
		QueueName: aws.String(queueName),
	})
	if err != nil {
		return nil, fmt.Errorf("get queue URL for %s: %w", queueName, err)
	}

	return &SQSProducer{
		client:   client,
		queueURL: *result.QueueUrl,
	}, nil
}

// CheckReachable verifies the queue exists.
func (p *SQSProducer) CheckReachable(ctx context.Context) error {
	_, err := p.client.GetQueueUrl(ctx, &sqs.GetQueueUrlInput{
		QueueName: aws.String(extractQueueName(p.queueURL)),
	})
	if err != nil {
		return fmt.Errorf("SQS queue unreachable: %w", err)
	}
	return nil
}

// Send sends a message to the FIFO queue.
// messageGroupID ensures ordering per wallet.
//
// Retries with exponential backoff on rate-limit errors (LocalStack's SQS
// has a much lower throughput than real AWS SQS). Non-rate-limit errors
// are returned immediately.
func (p *SQSProducer) Send(ctx context.Context, messageGroupID string, payload map[string]any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	dedupID := fmt.Sprintf("%s-%d", messageGroupID, time.Now().UnixNano())
	if err := p.sendWithRetry(ctx, messageGroupID, dedupID, string(data)); err != nil {
		p.SendFailures.Add(1)
		p.logf(LogError, "SQS send group=%s dedup=%s: %v", messageGroupID, dedupID, err)
		return fmt.Errorf("send message: %w", err)
	}
	p.logf(LogDebug, "SQS sent group=%s dedup=%s (%d bytes)", messageGroupID, dedupID, len(data))
	return nil
}

// sendWithRetry sends a message, retrying with exponential backoff on
// rate-limit errors. Non-rate-limit errors are returned immediately.
func (p *SQSProducer) sendWithRetry(ctx context.Context, messageGroupID, dedupID, body string) error {
	const maxAttempts = 5
	backoff := 50 * time.Millisecond

	for attempt := 0; attempt < maxAttempts; attempt++ {
		if p.rateLimiter != nil {
			if err := p.rateLimiter.wait(ctx); err != nil {
				return err
			}
		}

		_, err := p.client.SendMessage(ctx, &sqs.SendMessageInput{
			QueueUrl:               aws.String(p.queueURL),
			MessageBody:            aws.String(body),
			MessageGroupId:         aws.String(messageGroupID),
			MessageDeduplicationId: aws.String(dedupID),
		})
		if err == nil {
			return nil
		}
		if !isRateLimitError(err) {
			return err
		}
		if attempt == maxAttempts-1 {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff *= 2
	}
	return nil // unreachable
}

// isRateLimitError checks if the error is a LocalStack/AWS rate-limit error.
func isRateLimitError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "rate limit") ||
		strings.Contains(msg, "TooManyRequests") ||
		strings.Contains(msg, "retry quota exceeded")
}

// SendRaw sends a pre-serialized JSON string to the FIFO queue.
func (p *SQSProducer) SendRaw(ctx context.Context, messageGroupID, dedupID, body string) error {
	_, err := p.client.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl:               aws.String(p.queueURL),
		MessageBody:            aws.String(body),
		MessageGroupId:         aws.String(messageGroupID),
		MessageDeduplicationId: aws.String(dedupID),
	})
	if err != nil {
		return fmt.Errorf("send message: %w", err)
	}
	return nil
}

func extractQueueName(url string) string {
	// URL format: http://endpoint/queue-name
	for i := len(url) - 1; i >= 0; i-- {
		if url[i] == '/' {
			return url[i+1:]
		}
	}
	return url
}

// ---------------------------------------------------------------------------
// Rate limiter (token bucket)
// ---------------------------------------------------------------------------

// rateLimiter is a simple token-bucket rate limiter. It allows up to `rps`
// tokens per second, with a burst capacity of `rps` tokens. The `wait` method
// blocks until a token is available or the context is cancelled.
type rateLimiter struct {
	rate     float64 // tokens per second
	burst    int64   // max tokens in the bucket
	tokens   float64
	lastTick time.Time
	mu       sync.Mutex
}

func newRateLimiter(rps int) *rateLimiter {
	return &rateLimiter{
		rate:     float64(rps),
		burst:    int64(rps),
		tokens:   float64(rps), // start full
		lastTick: time.Now(),
	}
}

// wait blocks until a token is available or ctx is cancelled.
func (rl *rateLimiter) wait(ctx context.Context) error {
	for {
		rl.mu.Lock()
		now := time.Now()
		elapsed := now.Sub(rl.lastTick).Seconds()
		rl.lastTick = now
		rl.tokens += elapsed * rl.rate
		if rl.tokens > float64(rl.burst) {
			rl.tokens = float64(rl.burst)
		}
		if rl.tokens >= 1.0 {
			rl.tokens -= 1.0
			rl.mu.Unlock()
			return nil
		}
		// Calculate how long to wait for the next token.
		deficit := 1.0 - rl.tokens
		waitDur := time.Duration(deficit / rl.rate * float64(time.Second))
		rl.mu.Unlock()

		if waitDur < time.Millisecond {
			waitDur = time.Millisecond
		}
		if waitDur > time.Second {
			waitDur = time.Second
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(waitDur):
		}
	}
}
