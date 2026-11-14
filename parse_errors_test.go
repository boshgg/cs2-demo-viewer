package main

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"unicode/utf8"

	demo "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs"
)

func TestDemoParseErrorHidesDispatcherStackButPreservesCause(t *testing.T) {
	raw := errors.New("nextByte: insufficient buffer (725 of 725)\nstacktrace: goroutine 91 [running]:\nruntime/debug.Stack()\nC:/Users/private-user/go/pkg/mod/github.com/markus-wa/godispatch@v1.4.1/dispatch.go:197\n(*Dispatcher).dispatchWithRecover()")
	err := demoParseError(raw)
	if !strings.Contains(err.Error(), "insufficient buffer") || !strings.Contains(err.Error(), "兼容") {
		t.Fatalf("missing actionable diagnosis: %v", err)
	}
	for _, private := range []string{"stacktrace", "goroutine", "runtime/debug", "C:/Users", "private-user", "dispatch.go", "725"} {
		if strings.Contains(err.Error(), private) {
			t.Fatalf("page error leaks %q: %v", private, err)
		}
	}
	if strings.ContainsAny(err.Error(), "\r\n") || utf8.RuneCountInString(err.Error()) > 150 {
		t.Fatalf("page error is not concise: %v", err)
	}
	if errors.Unwrap(err) != raw || !errors.Is(err, raw) {
		t.Fatal("raw diagnostic was not preserved for server logging")
	}
}

func TestDemoParseErrorClassifiesKnownReadFailures(t *testing.T) {
	for _, tc := range []struct {
		name  string
		cause error
		want  string
	}{
		{"eof", io.EOF, "Demo 提前结束"},
		{"unexpected-eof", io.ErrUnexpectedEOF, "Demo 提前结束"},
		{"upstream-truncated", demo.ErrUnexpectedEndOfDemo, "Demo 提前结束"},
		{"invalid-header", demo.ErrInvalidFileType, "文件格式无法识别"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cause := fmt.Errorf("internal context from C:/private/demo.dem: %w", tc.cause)
			err := demoParseError(cause)
			if !strings.HasPrefix(err.Error(), tc.want) || strings.Contains(err.Error(), "C:/private") {
				t.Fatalf("unexpected page error: %v", err)
			}
			if errors.Unwrap(err) != cause || !errors.Is(err, tc.cause) {
				t.Fatal("wrapped sentinel is no longer discoverable")
			}
		})
	}
}

func TestDemoParseErrorHandlesUnknownAndNilErrors(t *testing.T) {
	if demoParseError(nil) != nil {
		t.Fatal("nil must remain nil")
	}
	raw := errors.New("private payload\nstacktrace: C:/private/file.dem")
	err := demoParseError(raw)
	if !strings.Contains(err.Error(), "解析失败") || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "stacktrace") {
		t.Fatalf("unknown error was not safely summarized: %v", err)
	}
	if demoParseError(err) != err {
		t.Fatal("already summarized errors should not be wrapped repeatedly")
	}
}
