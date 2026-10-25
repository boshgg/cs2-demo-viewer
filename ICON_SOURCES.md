# 装备图标来源

`web/icons/` 内的武器、投掷物、护甲、拆包钳和击杀修饰图标来自 Valve 的 Counter-Strike 2 游戏资源，经 [Juknum/counter-strike-icons](https://github.com/Juknum/counter-strike-icons) 自动提取镜像取得。固定版本：[`92fa323cb5f954f310b8d653a7c280f5d1335163`](https://github.com/Juknum/counter-strike-icons/tree/92fa323cb5f954f310b8d653a7c280f5d1335163)，下载日期 2026-10-25。

- 装备：`cs2/panorama/images/icons/equipment/*.svg`
- 击杀修饰：`cs2/panorama/images/hud/deathnotice/*.svg`
- `web/icons/sources.json` 记录每个图标的原始路径和本地文件 SHA-256。
- 本地版本只移除了 XML 声明、DOCTYPE 和生成器注释；没有改写原始图形。
- `web/icons/unknown.svg` 为本查看器原创的装备箱后备图标。

这些游戏图形归 Valve Corporation 所有，不属于本项目代码的开源许可。上游完整版权说明保存在 `licenses/counter-strike-icons-LICENSE.txt`。上游说明其用于资讯和社区用途，商业使用需得到 Valve 许可。本工具使用本地图标识别录像中的装备，没有使用 TGPRO 的品牌或私有资源。

图标随程序嵌入，不依赖网络。`web/icons.js` 根据 demoinfocs 的装备名称匹配剪影，并保留可访问名称和鼠标悬停名称。特别注意：demoinfocs 的 `M4A1` 是 M4A1-S，而原始游戏资源 `m4a1.svg` 对应 M4A4；映射中已分别处理。绘制用 Canvas 缓存着色结果，原始 SVG 保留不变。
