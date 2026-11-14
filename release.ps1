param([string]$Version = '4.0.5')
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
New-Item -ItemType Directory -Path (Join-Path $packageDirectory 'demo') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $packageDirectory 'demo\README.txt'), '将 .dem 或包含 .dem 的 .zip 放入此文件夹。启动时自动读取；网页打开后点击“刷新文件夹”添加新录像。ZIP 自动提取，重复内容只统计一次；原始文件不会因移除分析记录而删除。', [Text.UTF8Encoding]::new($true))
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
2. 将 .dem 或包含 .dem 的 .zip 放入本目录 demo 文件夹，启动后自动读取并提取 ZIP 中的录像；也可在网页手动导入 .dem。
3. 浏览器打开 http://127.0.0.1:8765/analysis.html，按地图、玩家ID、队伍和CT/T筛选叠加，不设10场数量上限。
4. 网页已经打开时，点击“刷新文件夹”读取新加入或修改的 Demo / ZIP，重复刷新不会重复添加；相同内容只分析一次。
5. 选择地图后，比赛来源只显示本地图的录像；尚未识别地图的任务单独显示。查看移动、交火、死亡热力图，以及道具数量、频率与代表轨迹。

已包含可执行程序，不需要安装 Go、Node.js 或 CS2。地图与图标内嵌，可离线使用。
保持启动终端开启，在终端按 Ctrl+C 停止。解析记录保存在本目录 data 文件夹，重启会自动恢复，无需逐个重新导入；原始 demo 文件不会删除。
原目录升级时替换 bin 程序和说明文件，保留 demo 与 data 文件夹；目录名可以继续使用旧版本名。
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
