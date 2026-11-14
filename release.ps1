param([string]$Version = '4.0.1')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Use a numeric semantic version, for example 4.0.0.' }
$goCommand = Get-Command go -ErrorAction SilentlyContinue
$goExecutable = if ($goCommand) { $goCommand.Source } else { Join-Path $env:LOCALAPPDATA 'Programs\cs2-viewer-tools\go\bin\go.exe' }
if (-not (Test-Path -LiteralPath $goExecutable)) { throw 'Install Go 1.24 or later before building a release.' }
$commit = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'A committed Git checkout is required.' }
$changes = & git status --porcelain --untracked-files=normal
if ($changes) { throw 'Commit source changes before producing a release.' }
$packageName = "cs2-demo-viewer-v$Version-windows-amd64"
$outputDirectory = Join-Path $PSScriptRoot 'dist'
$stageDirectory = Join-Path $outputDirectory ("stage-" + [Guid]::NewGuid().ToString('N'))
$packageDirectory = Join-Path $stageDirectory $packageName
$binaryDirectory = Join-Path $packageDirectory 'bin'
New-Item -ItemType Directory -Path $binaryDirectory -Force | Out-Null
$oldGoos, $oldGoarch, $oldCgo = $env:GOOS, $env:GOARCH, $env:CGO_ENABLED
try {
    $env:GOOS = 'windows'; $env:GOARCH = 'amd64'; $env:CGO_ENABLED = '0'
    & $goExecutable build -trimpath -ldflags '-s -w' -o (Join-Path $binaryDirectory 'cs2-viewer.exe') .
    if ($LASTEXITCODE -ne 0) { throw 'Release build failed.' }
} finally { $env:GOOS = $oldGoos; $env:GOARCH = $oldGoarch; $env:CGO_ENABLED = $oldCgo }
foreach ($file in @('README.md','ICON_SOURCES.md','MAP_SOURCES.md')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $packageDirectory
}
foreach ($folder in @('licenses','docs')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $folder) -Destination $packageDirectory -Recurse
}
$goRoot = (& $goExecutable env GOROOT).Trim()
Copy-Item -LiteralPath (Join-Path $goRoot 'LICENSE') -Destination (Join-Path $packageDirectory 'licenses\Go-LICENSE.txt')
$launcher = @'
@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0bin\cs2-viewer.exe" (
  echo Missing bin\cs2-viewer.exe. Extract the complete ZIP before starting.
  pause
  exit /b 1
)
"%~dp0bin\cs2-viewer.exe" -open %*
if errorlevel 1 pause
'@
[IO.File]::WriteAllText((Join-Path $packageDirectory 'Start Viewer.cmd'), ($launcher -replace "`r?`n", "`r`n"), [Text.Encoding]::ASCII)
$readme = @"
CS2 Replay v$Version - Windows x64 便携版

1. 完整解压本文件夹，双击 Start Viewer.cmd。
2. 浏览器打开 http://127.0.0.1:8765，导入 .dem 进行回放。
3. 点击“多 Demo 分析”，最多导入10场，按地图、玩家ID、队伍和CT/T筛选叠加。
4. 查看移动、交火、死亡热力图，以及道具落点区域和相同投法的数量、频率与代表轨迹。

已包含可执行程序，不需要安装 Go、Node.js 或 CS2。地图与图标内嵌，可离线使用。
保持启动终端开启，在终端按 Ctrl+C 停止。服务重启会清理临时比赛缓存，需要重新导入。
若端口冲突，在本目录运行 bin\cs2-viewer.exe -port 8766 -open。
统计口径、地图版本限制和素材归属请参阅 README.md、MAP_SOURCES.md、ICON_SOURCES.md 及 licenses。

版本：$Version
源码提交：$commit
"@
[IO.File]::WriteAllText((Join-Path $packageDirectory 'README.txt'), $readme, [Text.UTF8Encoding]::new($true))
$toolchain = & $goExecutable version
"version=$Version`ncommit=$commit`nplatform=windows/amd64`ntoolchain=$toolchain`nbuiltUTC=$([DateTime]::UtcNow.ToString('o'))" | Set-Content -LiteralPath (Join-Path $packageDirectory 'VERSION.txt') -Encoding utf8
$zip = Join-Path $outputDirectory "$packageName.zip"
Compress-Archive -LiteralPath $packageDirectory -DestinationPath $zip -CompressionLevel Optimal -Force
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $packageName.zip" | Set-Content -LiteralPath "$zip.sha256" -Encoding ascii
Write-Output "Release: $zip"
Write-Output "SHA256: $hash"
