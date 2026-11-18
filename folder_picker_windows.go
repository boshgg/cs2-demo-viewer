package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// Windows PowerShell ships with Windows and can open the native folder dialog
// in an STA thread. Pass the initial directory as data, never as script text.
const windowsFolderDialog = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
try {
    $owner.ShowInTaskbar = $false
    $owner.TopMost = $true
    $owner.Opacity = 0
    $owner.Show()
    $owner.Activate()
    $dialog.Description = '选择录像文件夹'
    $dialog.ShowNewFolderButton = $false
    $dialog.SelectedPath = $env:CS2_PICKER_INITIAL_DIRECTORY
    if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)
        [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
    }
} finally {
    $dialog.Dispose()
    $owner.Dispose()
}`

func browseDemoFolder(ctx context.Context, initial string) (string, error) {
	powershell := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	cmd := exec.CommandContext(ctx, powershell, "-NoProfile", "-NonInteractive", "-STA", "-Command", windowsFolderDialog)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Env = append(os.Environ(), "CS2_PICKER_INITIAL_DIRECTORY="+initial)
	output, err := cmd.Output()
	return string(output), err
}
