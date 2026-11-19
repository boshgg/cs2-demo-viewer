//go:build !windows

package main

// Source builds on POSIX rely on the user's private configuration directory
// (0700) and the credential file's owner-only permissions (0600).
func sealInsightsCredential(plain []byte, _ string) ([]byte, error)  { return plain, nil }
func openInsightsCredential(stored []byte, _ string) ([]byte, error) { return stored, nil }
