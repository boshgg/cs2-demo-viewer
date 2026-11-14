//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
)

func lockLibrary(root string) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(root, "library.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}
