package core

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"time"
)

// DefaultAuthToken is used when no explicit token is configured.
// The backend's default NoopTokenValidator (AUTH_ENABLED=false) accepts
// any non-empty token, so a static dev token is sufficient for local
// stress testing. Override with AUTH_TOKEN / -token for real IdP tokens.
const DefaultAuthToken = "stress-test-dev-token"

// HTTPClient wraps net/http with retry, timeout, and idempotency support.
type HTTPClient struct {
	client    *http.Client
	baseURLs  []string
	rr        int // round-robin index
	rng       *rand.Rand
	log       *Logger
	authToken string
}

// NewHTTPClient creates an HTTPClient that round-robins across baseURLs.
func NewHTTPClient(baseURLs []string) *HTTPClient {
	// Connection pooling: limita conexões simultâneas por host para evitar
	// esgotamento de portas efêmeras no host (TIME_WAIT accumulation).
	// Sem isso, ~5000 goroutines × rajadas de requests criam milhares de
	// conexões TCP novas, esgotando o range 32768-60999 (28k portas).
	transport := &http.Transport{
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   50,
		MaxConnsPerHost:       200, // hard limit: nunca mais que 200 conexões simultâneas por host
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}

	return &HTTPClient{
		client: &http.Client{
			Timeout:   10 * time.Second,
			Transport: transport,
		},
		baseURLs: baseURLs,
		rng:      rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

// SetLogger attaches a logger to the HTTP client.
func (h *HTTPClient) SetLogger(l *Logger) {
	h.log = l
}

// SetAuthToken sets the Bearer token sent on every request.
// If empty, DefaultAuthToken is used (sufficient for the backend's
// NoopTokenValidator when AUTH_ENABLED=false).
func (h *HTTPClient) SetAuthToken(token string) {
	h.authToken = token
}

// logf is a safe no-op if no logger is set.
func (h *HTTPClient) logf(level LogLevel, format string, args ...any) {
	if h.log != nil {
		h.log.Logf(level, format, args...)
	}
}

// nextBaseURL returns the next base URL in round-robin fashion.
func (h *HTTPClient) nextBaseURL() string {
	idx := h.rr % len(h.baseURLs)
	h.rr++
	return h.baseURLs[idx]
}

// CheckReadiness verifies that all backends are reachable via GET /health/ready.
func (h *HTTPClient) CheckReadiness(ctx context.Context) error {
	for _, url := range h.baseURLs {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+"/health/ready", nil)
		if err != nil {
			return fmt.Errorf("create request: %w", err)
		}
		resp, err := h.client.Do(req)
		if err != nil {
			return fmt.Errorf("backend %s unreachable: %w", url, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("backend %s not ready: HTTP %d", url, resp.StatusCode)
		}
	}
	return nil
}

// CreateWallet sends POST /wallets.
func (h *HTTPClient) CreateWallet(ctx context.Context, body map[string]any) (*HTTPResult, error) {
	return h.doRequest(ctx, http.MethodPost, "/wallets", nil, body)
}

// SubmitTransaction sends POST /wagering/transactions with Idempotency-Key header.
func (h *HTTPClient) SubmitTransaction(ctx context.Context, idempotencyKey string, body map[string]any) (*HTTPResult, error) {
	headers := map[string]string{
		"Idempotency-Key": idempotencyKey,
	}
	return h.doRequest(ctx, http.MethodPost, "/wagering/transactions", headers, body)
}

// GetWallet sends GET /wallets/:id.
func (h *HTTPClient) GetWallet(ctx context.Context, walletID string) (*HTTPResult, error) {
	return h.doRequest(ctx, http.MethodGet, "/wallets/"+walletID, nil, nil)
}

// GetWalletLedger sends GET /wallets/:id/ledger.
func (h *HTTPClient) GetWalletLedger(ctx context.Context, walletID, cursor string, limit int) (*HTTPResult, error) {
	path := fmt.Sprintf("/wallets/%s/ledger?limit=%d", walletID, limit)
	if cursor != "" {
		path += "&cursor=" + cursor
	}
	return h.doRequest(ctx, http.MethodGet, path, nil, nil)
}

// Reconcile sends POST /wallets/:id/reconciliation.
func (h *HTTPClient) Reconcile(ctx context.Context, walletID string) (*HTTPResult, error) {
	return h.doRequest(ctx, http.MethodPost, "/wallets/"+walletID+"/reconciliation", nil, nil)
}

// GetTransaction sends GET /wagering/transactions/:id.
func (h *HTTPClient) GetTransaction(ctx context.Context, transactionID string) (*HTTPResult, error) {
	return h.doRequest(ctx, http.MethodGet, "/wagering/transactions/"+transactionID, nil, nil)
}

// GetTransactionByProvider sends GET /providers/:providerId/wagering/transactions/:extId.
func (h *HTTPClient) GetTransactionByProvider(ctx context.Context, providerID, extID string) (*HTTPResult, error) {
	path := fmt.Sprintf("/providers/%s/wagering/transactions/%s", providerID, extID)
	return h.doRequest(ctx, http.MethodGet, path, nil, nil)
}

// HTTPResult holds the raw HTTP response.
type HTTPResult struct {
	StatusCode int
	Body       []byte
	Header     http.Header
	Latency    time.Duration
}

// JSON unmarshals the response body into v.
func (r *HTTPResult) JSON(v any) error {
	return json.Unmarshal(r.Body, v)
}

// doRequest executes an HTTP request with retry on 5xx and connection errors.
func (h *HTTPClient) doRequest(ctx context.Context, method, path string, headers map[string]string, body any) (*HTTPResult, error) {
	const maxRetries = 5
	const baseDelay = 200 * time.Millisecond

	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			// Exponential backoff + jitter (0-100ms) para evitar thundering herd
			// quando múltiplos clients tentam recuperar simultaneamente após falha.
			delay := baseDelay * time.Duration(1<<(attempt-1))
			jitter := time.Duration(h.rng.Intn(100)) * time.Millisecond
			delay += jitter
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(delay):
			}
		}

		result, err := h.singleRequest(ctx, method, path, headers, body)
		if err != nil {
			lastErr = err
			h.logf(LogError, "HTTP %s %s attempt %d: error: %v", method, path, attempt+1, err)
			// Connection errors are retryable
			continue
		}

		// 5xx is retryable
		if result.StatusCode >= 500 {
			lastErr = fmt.Errorf("HTTP %d: %s", result.StatusCode, string(result.Body))
			h.logf(LogWarn, "HTTP %s %s attempt %d: %d %s", method, path, attempt+1, result.StatusCode, truncateBody(result.Body, 200))
			continue
		}

		h.logf(LogDebug, "HTTP %s %s: %d (%s)", method, path, result.StatusCode, result.Latency)
		return result, nil
	}

	h.logf(LogError, "HTTP %s %s: failed after %d attempts: %v", method, path, maxRetries+1, lastErr)
	return nil, fmt.Errorf("request failed after %d attempts: %w", maxRetries+1, lastErr)
}

// truncateBody truncates a response body to maxLen bytes for logging.
func truncateBody(body []byte, maxLen int) string {
	if len(body) <= maxLen {
		return string(body)
	}
	return string(body[:maxLen]) + "..."
}

func (h *HTTPClient) singleRequest(ctx context.Context, method, path string, headers map[string]string, body any) (*HTTPResult, error) {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal body: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	baseURL := h.nextBaseURL()
	req, err := http.NewRequestWithContext(ctx, method, baseURL+path, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	token := h.authToken
	if token == "" {
		token = DefaultAuthToken
	}
	req.Header.Set("Authorization", "Bearer "+token)
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	start := time.Now()
	resp, err := h.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("do request: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}

	return &HTTPResult{
		StatusCode: resp.StatusCode,
		Body:       data,
		Header:     resp.Header,
		Latency:    time.Since(start),
	}, nil
}
