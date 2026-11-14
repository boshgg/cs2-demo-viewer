package main

import (
	"path/filepath"
	"syscall"
)

// A Windows short (8.3) name is another name for the same directory, not a
// redirect. Inspect every ancestor's attributes instead of comparing the
// spelling returned by EvalSymlinks, which also expands legitimate short names.
func unlinkedPath(file string) bool {
	current, err := filepath.Abs(file)
	if err != nil {
		return false
	}
	for {
		name, err := syscall.UTF16PtrFromString(current)
		if err != nil {
			return false
		}
		attributes, err := syscall.GetFileAttributes(name)
		if err != nil || attributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return false
		}
		parent := filepath.Dir(current)
		if parent == current {
			return true
		}
		current = parent
	}
}
