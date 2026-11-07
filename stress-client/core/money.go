package core

import (
	"fmt"
	"strconv"
	"strings"
)

// Money represents a monetary amount as integer cents to avoid floating-point
// issues. The API contract uses decimal strings with 2 decimal places.
type Money struct {
	Cents    int64
	Currency string
}

// NewMoney creates a Money from a decimal string (e.g. "25.00") and currency.
func NewMoney(amount, currency string) (Money, error) {
	cents, err := parseDecimalToCents(amount)
	if err != nil {
		return Money{}, fmt.Errorf("invalid amount %q: %w", amount, err)
	}
	if len(currency) != 3 {
		return Money{}, fmt.Errorf("invalid currency %q: must be 3 chars (ISO-4217)", currency)
	}
	return Money{Cents: cents, Currency: currency}, nil
}

// RandSource is the minimal RNG surface needed to generate random values.
// Both *rand.Rand and *lockedRand satisfy it.
type RandSource interface {
	Float64() float64
	Int63n(n int64) int64
	Intn(n int) int
}

// RandomMoney generates a random Money between minCents and maxCents (inclusive).
func RandomMoney(minCents, maxCents int64, currency string, rng RandSource) Money {
	if minCents > maxCents {
		minCents, maxCents = maxCents, minCents
	}
	cents := minCents + rng.Int63n(maxCents-minCents+1)
	return Money{Cents: cents, Currency: currency}
}

// String returns the decimal string representation (e.g. "25.00").
func (m Money) String() string {
	return CentsToDecimal(m.Cents)
}

// ToJSON returns the API representation.
func (m Money) ToJSON() map[string]string {
	return map[string]string{
		"amount":   m.String(),
		"currency": m.Currency,
	}
}

// parseDecimalToCents converts "123.45" to 12345.
func parseDecimalToCents(s string) (int64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("empty string")
	}

	neg := false
	if s[0] == '-' {
		neg = true
		s = s[1:]
	}

	var intPart, fracPart string
	dotIdx := strings.IndexByte(s, '.')
	if dotIdx == -1 {
		intPart = s
	} else {
		intPart = s[:dotIdx]
		fracPart = s[dotIdx+1:]
		if len(fracPart) > 2 {
			return 0, fmt.Errorf("more than 2 decimal places: %q", s)
		}
	}

	if intPart == "" {
		intPart = "0"
	}

	intVal, err := strconv.ParseInt(intPart, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid integer part: %w", err)
	}

	var fracVal int64
	if len(fracPart) == 1 {
		fracVal, _ = strconv.ParseInt(fracPart+"0", 10, 64)
	} else if len(fracPart) == 2 {
		fracVal, _ = strconv.ParseInt(fracPart, 10, 64)
	}

	cents := intVal*100 + fracVal
	if neg {
		cents = -cents
	}
	return cents, nil
}

// CentsToDecimal converts integer cents to a decimal string (e.g. 12345 → "123.45").
func CentsToDecimal(cents int64) string {
	neg := cents < 0
	if neg {
		cents = -cents
	}
	intPart := cents / 100
	fracPart := cents % 100
	s := fmt.Sprintf("%d.%02d", intPart, fracPart)
	if neg {
		s = "-" + s
	}
	return s
}
