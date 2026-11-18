# AI 复盘与 MCP 接入

## 在查看器中提问

1. 启动查看器，打开 **AI 分析**。选择 1–8 场已完成解析的比赛。新录像先在比赛回放的录像库中打开并等待解析。没有录像时可选择「使用合成示例」。
2. 从「分析对象」选择全部比赛、一名玩家或一支战队。「本地复盘图」可切换地图、队伍、CT/T、回合阶段和图层，也可以保存 PNG。第 15 秒站位图按人次统计解冻后仍存活且有坐标的选手，中期换位图连接同一选手在该回合开局和中期各自停留最久的网格。选择比赛后即可在本机看图。
3. 在「模型连接」选择厂商。选择智谱 GLM 或 DeepSeek 后，填入对应厂商的 API 密钥即可；模型名称可改成该账户支持的模型 ID。其他服务选择「自定义（其他厂商）」。
4. 输入问题，例如「这几场 Ancient 上，FURIA 的 CT 第 15 秒常站哪里？进入中期常换到哪？用坐标、回合数和击杀死亡数据说明」。确认按钮旁显示的服务和模型后，点击「发送并分析」。

| 模型厂商 | API 基础地址 | 默认模型 |
| --- | --- | --- |
| [智谱 GLM（国内通用 API）](https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash) | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.7-flash` |
| [DeepSeek](https://api-docs.deepseek.com/zh-cn/) | `https://api.deepseek.com` | `deepseek-flash` |
| 自定义 | 填写兼容 Chat Completions 的服务地址，例如本机 [Ollama](https://docs.ollama.com/api/openai-compatibility) 的 `http://127.0.0.1:11434/v1` | 填写该服务提供的模型 ID |

页面在发送时把问题、比赛统计和空间证据交给所选模型。证据可含玩家名字、ID、队名、比赛、回合和坐标。切换厂商、修改自定义地址、刷新或离开页面时，手动填写的密钥会清空。本机免密服务可以留空密钥。外部模型的使用费用和数据处理取决于你选用的服务。

支持在聊天回答中返回图片的模型可同时显示文字和图片，也可只返回图片。自定义或系统默认服务若要求显式声明图片输出，可勾选「请求模型出图」。内嵌 PNG、JPEG 和 GIF 可放大或保存，HTTPS 外链图需点击加载。查看器根据 Demo 绘制的雷达图在「本地复盘图」中单独显示。

要预设模型，在启动查看器的进程环境中设置 `CS2_AI_BASE_URL`、`CS2_AI_MODEL`，并按需设置 `CS2_AI_API_KEY`。然后从该环境启动查看器。如果已有实例在运行，请先关闭。有有效配置时，页面会优先选中「系统默认」。切换到其他厂商后，可随时选回「系统默认」。

## 连接外部 AI Agent

先启动查看器。在 **AI 分析 → Agent 接入** 中复制生成的 JSON，将其中的服务条目合并到客户端的 MCP 配置，然后让客户端重新加载。支持 stdio 的客户端会自动启动程序的 MCP 模式。客户端和查看器须在同一台机器上运行。程序移动或运行端口变化后可重新复制配置。

在 PowerShell 中，也可从查看器的安装目录将其登记给 Codex CLI：

```powershell
$viewer = (Resolve-Path '.\bin\cs2-viewer.exe').Path
codex mcp add cs2-replay -- $viewer -mcp
```

此方式会寻找默认端口及其后续 19 个端口上正在运行的同版本查看器。要指定某个实例，可在 `-mcp` 后附加 `-viewer-url http://127.0.0.1:8767`，端口以启动窗口显示的为准。也可手动在客户端的 TOML 配置中添加下列条目，将路径替换为实际安装路径。

```toml
[mcp_servers.cs2-replay]
command = 'C:\CS2Replay\bin\cs2-viewer.exe'
args = ['-mcp']
```

| Agent 工具 | 用途 |
|---|---|
| `list_demos` | 分页列出录像，可按名称、地图或 ID 搜索 |
| `refresh_library` | 扫描本机配置的录像目录 |
| `parse_demo` | 选择一场入库录像并排队解析，可指定 playback 或 analysis |
| `get_demo_status` | 查询解析进度与版本，等待 ready 后读取统计 |
| `get_match_statistics` | 查看单场统计，可指定 round 读取一回合的交锋和经济 |
| `get_analysis_evidence` | 提取跨场统计和空间证据，可按玩家或战队筛选 |

例如，让 Agent「找出 Mirage 上已解析的三场比赛，用 get_analysis_evidence 列出选手和战队。选定队伍后，结合逐回合统计说明其优势、问题和证据最少的结论」。选择对象时使用证据返回的 ID。空库验证可让 Agent 调用 `get_analysis_evidence`，参数为 `{"demoIds":["sample"]}`。MCP 客户端可以直接用自己的模型分析返回结果，无需在查看器里另配 Key。

## 本机 HTTP API

使用查看器实际监听的地址，将 POST 请求的 Content-Type 设置为 application/json。

| 请求 | 用途 |
|---|---|
| GET /api/insights/config | 查看默认模型是否已配置、模型名称及目标服务来源 |
| GET /api/insights/mcp-config | 生成当前可执行文件和端口对应的 stdio 客户端配置 |
| POST /api/insights/evidence | 用 demoIds 指定比赛；可附加 playerId 或 team 之一 |
| POST /api/insights/ask | 在相同选择条件上增加 question。返回 answer、model、evidence 和可选的图片列表 images |

两个入口（HTTP 与 MCP）的证据都包含 `spatial`。每个 `groups` 条目对应地图、战队、CT/T 和阶段，列出样本比赛、回合数、六项全量合计及代表性坐标网格。XY 网格宽 384 个游戏单位，Z 高 128。以解冻为零秒，开局为 [0,20)，中期为 [20,60)，之后为后期，时间缺失时单列。按 `spatial.method` 解读数组和单位。开局可查看 `openingAt15`，中期可查看 `moves`。A/B 参照来自录像中可核实的下包点，其他地图俗称需要额外的报点依据。比较死亡或击杀较多的网格时，应同时参考停留时长和覆盖回合数。

页面调用 ask 时会通过 `chartContext` 附上当前图层及已标记的坐标，可直接问「图中第 1 处为什么值得关注」。若聊天服务支持，可以给 ask 请求附加 `imageOutput: true` 以发送 `modalities: ["image","text"]`。返回的 `images` 条目包含 `url` 和可选的 `alt`，纯图片回答的 `answer` 可为空。每次最多接收四张图。部分图片无效时，接口可同时返回 `imageWarning` 和其余有效内容。

```powershell
$origin = 'http://127.0.0.1:8767'
$scope = @{ demoIds = @('sample') }
Invoke-RestMethod "$origin/api/insights/evidence" -Method Post -ContentType 'application/json' -Body ($scope | ConvertTo-Json)
# 使用服务端预设的模型连接：
$request = @{ demoIds = @('sample'); question = '哪些回合值得复看？请给出依据。' }
Invoke-RestMethod "$origin/api/insights/ask" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json)))
```

也可在 ask 请求中一并提供 baseUrl、model 和该服务自己的 apiKey。API 仅在本机开放。MCP 使用 [标准输入输出协议](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) 连接同版本查看器。
