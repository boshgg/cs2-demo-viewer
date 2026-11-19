param([string]$Version = '4.3.4')
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
[IO.File]::WriteAllText((Join-Path $packageDirectory 'demo\README.txt'), '此处是默认录像目录。也可在查看器中点击“选择文件夹”，直接使用已有的 .dem 或 .zip 录像目录。启动或点击“刷新文件夹”时更新本地录像库并去重，不自动解析全部比赛。在回放页选一场播放，或在分析页勾选录像后加入分析；已有缓存直接复用。原始文件保留。', [Text.UTF8Encoding]::new($true))
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
   在「AI 分析」勾选比赛后，可查看站位和交火雷达图、保存 PNG，或接入模型提问。外部 Agent 的 MCP 配置见 docs/AI_AND_MCP.md。
2. 在录像库点击「选择文件夹」，选择已有的录像目录或输入完整路径。查看器会记住选择，并递归扫描 .dem 和包含录像的 .zip。默认目录是安装目录下的 demo，新增文件后可点击「刷新文件夹」。
3. 回放页点击「本地录像库」，搜索文件名或文件夹，选择一场解析播放；已缓存的比赛直接打开。也可手动导入 .dem。
4. 分析页从本地录像库勾选需要的比赛并加入分析，按地图、玩家ID、队伍和CT/T筛选叠加，不设10场数量上限。
5. 数据分析支持单场与“跨 Demo 玩家”模式。跨场模式勾选多场后分析，可按地图或全部地图筛选，只汇总在至少两场所选比赛出现的相同玩家 ID，可选一人或多人查看逐杀、净值和“特了几个”。未选择的录像不解析。单场仍可查看回合经济与装备证据。
6. 扫描只更新录像列表并校验去重，不自动解析全部比赛。重复刷新、不同子目录、ZIP与原DEM中的相同内容不会重复统计；原始文件保留。
7. 旧缓存可在地图分析页点击「重新解析已导入」，或在数据分析页重新解析当前比赛 / 全部已解析录像。原文件或 ZIP 仍在 demo 目录时无需删除再导入；队伍分组和筛选保留，新结果完成后才替换旧缓存，失败可继续使用旧数据。
8. 道具统计可按正式开局后的出手时间筛选：0–5 秒、超过 5–20 秒、超过 20–50 秒、50 秒以后；缺失时间单独标记未知。落点、投法、数量及导出 CSV 同步更新，已有回放缓存会自动补充时间字段。
9. 在所选录像目录下自建子文件夹整理录像后刷新；回放、地图分析和数据分析均可切换「显示全部 / 按文件夹分类」，并选择一个文件夹。分类只改变列表显示，不清除已选比赛；多个目录中的同一份录像不会重复统计。ZIP 按 ZIP 文件所在目录分类。
10. 地图分析的比赛来源、本地录像库，以及跨 Demo 玩家分析，每个文件夹标题旁都有「全选 / 清空 / 反选」。操作该文件夹内全部录像（包含被地图和搜索隐藏的记录），其他文件夹独有的勾选保持不变。同一录像的多处来源会联动，只计一次；完成勾选后再点击「加入分析」或「分析所选比赛」。
11. 所有文件夹列表都支持单独折叠/展开和「全部折叠 / 全部展开」。各板块分别记住展开状态，刷新页面、切换搜索/地图或重新打开仍会恢复。折叠只隐藏列表，勾选、分析结果和文件夹批量操作均保持；全部折叠后新发现的文件夹也默认折叠。
12. 数据分析新增「死亡与综合影响」：首死、死亡前击杀、双方人数、手持枪械差、胜负及次回合装备变化均可展开核对。单场和跨 Demo 使用同一套模型，显示累计分、每回合分与暂定参考线；旧击杀净值继续保留。已有缓存自动派生新报告，不需要删除再导入。详细公式参阅 docs/IMPACT_SCORING.md。
13. 逐次死亡列表支持「扣分最多优先」排序，并可组合「只看首死」「只看输局死亡」。仅调整明细显示，原综合分与统计范围保持不变；点击回放可直接复盘对应死亡。
14. 击杀净值：低级武器杀高级武器的奖励不变；高级武器杀任何低级武器，仅当击杀者同回合有有效死亡记录时保留原负净值，否则记 0。同档仍为 0。「特了几个」次数与金色高亮保留原范围，死亡影响模块的规则不变。已有缓存自动更新统计结果，无需重新解析。
15. 地图分析的移动、交火、死亡、开火四层热力图共享双端时间滑块：拖动选择每回合倒计时 1:55 到 0:00 内任意时段，精确到秒，四层位置和计数同步更新。以冻结结束为起点，叠加已选比赛各回合的对应时段；道具仍使用独立出手时段筛选。可恢复整回合，时间选择自动记住。旧回放缓存自动补齐移动与事件时间，缺少可靠时间的记录按图层提示；不需要删除重新导入。
16. 热力图时间条支持固定窗口自动播放：设置窗口长度后播放，按 0.25 / 0.5 / 1 / 2 / 4 / 8 倍速逐秒推进，四层和计数同步更新。可暂停、继续或从 1:55 重播，到 0:00 自动停止且窗口不缩短。手动拖动或切换分析范围会暂停；倍速和窗口长度保留，刷新或重新打开后不会自行播放。

17. 在地图分析热力图的「下包阶段」选择下包前或下包后，可进一步指定距下包完成的秒数范围，如下包前最后 10 秒，也可与回合时间轴叠加。右侧「常见落点与投法」可独立按道具出手时的下包阶段和投掷时段筛选。选择落点后，点击雷达上的出手点或落点打开对应回合；附近有多条投掷记录时可按比赛选择。

已包含可执行程序，不需要安装 Go、Node.js 或 CS2。地图与图标内嵌，可离线使用。
保持启动终端开启，在终端按 Ctrl+C 停止。解析记录保存在本目录 data 文件夹，重启会自动恢复，无需逐个重新导入；原始 demo 文件不会删除。
原目录升级时替换 bin 程序和说明文件，保留 demo 与 data 文件夹。旧版升级后先在原目录启动一次，等待文件夹扫描完成并关闭程序；之后可重命名整个安装目录，缓存与原件的关联会保留。
默认优先使用 8765 端口；占用时依次尝试后续端口，连续 20 个候选都不可用时由系统分配空闲端口。浏览器会打开实际地址，也可查看启动终端。可用 -port 8766 指定首选端口，占用时仍会自动切换。
切换端口后，浏览器筛选偏好按新地址独立保存；demo 与 data 中的录像及解析缓存不受影响。同一 data 目录仍只能由一个进程使用，升级时请先关闭旧程序。
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
