//go:build windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
)

// A non-shared handle is released by Windows even after an abrupt process exit.
// The on-disk marker can remain; it is the handle, not its existence, that locks.
func lockLibrary(root string) (*os.File, error) {
	path := filepath.Join(root, "library.lock")
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(handle), path), nil
}
