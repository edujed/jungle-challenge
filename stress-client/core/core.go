package core

import (
	"context"
	"fmt"
)

// CoreOption is a functional option for NewCore.
type CoreOption func(*Core, *Config)

// WithSQS attaches an SQS producer to the Core (requires cfg.SQSEndpoint).
func WithSQS() CoreOption {
	return func(c *Core, cfg *Config) {
		if cfg.SQSEndpoint == "" {
			return
		}
		sqsProducer, err := NewSQSProducer(context.Background(), cfg.SQSEndpoint, cfg.SQSQueue)
		if err != nil {
			return
		}
		c.SQS = sqsProducer
	}
}

// NewCore builds a Core with an HTTP client (readiness-checked) and,
// optionally, an SQS producer. It is the single entry point for all
// standalone table CLIs and the orchestrator.
func NewCore(ctx context.Context, cfg *Config, opts ...CoreOption) (*Core, error) {
	httpClient := NewHTTPClient(cfg.BaseURLs)
	httpClient.SetAuthToken(cfg.AuthToken)
	if err := httpClient.CheckReadiness(ctx); err != nil {
		return nil, fmt.Errorf("backend not ready: %w", err)
	}

	c := &Core{
		HTTP:    httpClient,
		Metrics: NewMetrics(),
		Cfg:     cfg,
	}

	for _, opt := range opts {
		opt(c, cfg)
	}

	// If SQS was requested, verify reachability.
	if c.SQS != nil {
		if err := c.SQS.CheckReachable(ctx); err != nil {
			return nil, fmt.Errorf("SQS queue not reachable: %w", err)
		}
	}

	return c, nil
}
