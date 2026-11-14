//go:build !windows

package main

import "path/filepath"

func unlinkedPath(file string) bool {
	resolved, err := filepath.EvalSymlinks(file)
	return err == nil && filepath.Clean(file) == filepath.Clean(resolved)
}
