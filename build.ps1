$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$goCommand = Get-Command go -ErrorAction SilentlyContinue
if ($goCommand) {
    $goExecutable = $goCommand.Source
} else {
    $goExecutable = Join-Path $env:LOCALAPPDATA 'Programs\cs2-viewer-tools\go\bin\go.exe'
}
if (-not (Test-Path -LiteralPath $goExecutable)) {
    throw 'Go 1.24 or later is required to rebuild. Install Go from https://go.dev/dl/.'
}
New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'bin') -Force | Out-Null
& $goExecutable build -trimpath -ldflags '-s -w' -o (Join-Path $PSScriptRoot 'bin\cs2-viewer.exe') .
if ($LASTEXITCODE -ne 0) { throw 'Build failed. If the viewer is running, stop it with Ctrl+C and rebuild.' }
Write-Output 'Built bin\cs2-viewer.exe. Run Start Viewer.cmd to open the viewer.'
