//go:build !windows

package main

import (
	"context"
	"errors"
)

func browseDemoFolder(context.Context, string) (string, error) {
	return "", errors.New("native folder dialog unavailable")
}
