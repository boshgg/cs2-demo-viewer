//go:build windows

package main

import (
	"bytes"
	"runtime"
	"syscall"
	"unsafe"
)

// crypt32.dll is a system DLL registered by Go's syscall package.
var credentialCrypt32 = syscall.NewLazyDLL("crypt32.dll")
var protectInsightKey = credentialCrypt32.NewProc("CryptProtectData")
var unprotectInsightKey = credentialCrypt32.NewProc("CryptUnprotectData")

type credentialBlob struct {
	Size uint32
	Data *byte
}

func sealInsightsCredential(plain []byte, scope string) ([]byte, error) {
	return applyCredentialDPAPI(protectInsightKey, plain, scope)
}

func openInsightsCredential(sealed []byte, scope string) ([]byte, error) {
	return applyCredentialDPAPI(unprotectInsightKey, sealed, scope)
}

func applyCredentialDPAPI(proc *syscall.LazyProc, input []byte, scope string) ([]byte, error) {
	// Current-user protection is the default. Additional entropy binds each
	// protected blob to its provider and full (normalized) completion URL.
	entropy := []byte("cs2-demo-viewer/" + scope)
	in := credentialBlob{uint32(len(input)), unsafe.SliceData(input)}
	binding := credentialBlob{uint32(len(entropy)), unsafe.SliceData(entropy)}
	var output credentialBlob
	const cryptProtectUIForbidden = 1
	success, _, err := proc.Call(uintptr(unsafe.Pointer(&in)), 0, uintptr(unsafe.Pointer(&binding)),
		0, 0, cryptProtectUIForbidden, uintptr(unsafe.Pointer(&output)))
	runtime.KeepAlive(input)
	runtime.KeepAlive(entropy)
	if success == 0 {
		return nil, err
	}
	defer syscall.LocalFree(syscall.Handle(unsafe.Pointer(output.Data)))
	data := unsafe.Slice(output.Data, output.Size)
	defer clear(data)
	return bytes.Clone(data), nil
}
