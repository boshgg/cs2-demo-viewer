package main

import (
	"errors"
	"io"
	"strings"

	demo "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs"
)

// demoReadError keeps diagnostics available to server logs without exposing
// parser stack traces, local paths, or arbitrary file content to the page.
type demoReadError struct {
	message string
	cause   error
}

func (e *demoReadError) Error() string { return e.message }
func (e *demoReadError) Unwrap() error { return e.cause }

func demoParseError(cause error) error {
	if cause == nil {
		return nil
	}
	var existing *demoReadError
	if errors.As(cause, &existing) {
		return existing
	}
	message := "Demo 解析失败：当前解析器可能暂不兼容该录像，或文件不完整。请确认录像已完整下载、解压，并使用最新版查看器。"
	switch {
	case errors.Is(cause, demo.ErrInvalidFileType):
		message = "文件格式无法识别，请选择已解压的 CS2 .dem 文件。"
	case errors.Is(cause, demo.ErrUnexpectedEndOfDemo), errors.Is(cause, io.ErrUnexpectedEOF), errors.Is(cause, io.EOF):
		message = "Demo 提前结束，尚未读取到可回放的完整比赛数据。请重新下载并解压后重试。"
	case strings.Contains(strings.ToLower(cause.Error()), "insufficient buffer"):
		message = "Demo 数据读取失败（insufficient buffer）。可能是游戏版本兼容问题或文件不完整，请使用最新版查看器，并确认录像已完整下载、解压。"
	}
	return &demoReadError{message: message, cause: cause}
}
