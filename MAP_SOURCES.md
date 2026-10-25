# 地图资源与坐标

本地查看器内置 9 张 CS2 地图的雷达图；Nuke、Train、Vertigo 含上下层。所有图片与标定来自同一份 [Awpy 官方地图数据 release 2000935](https://github.com/pnxenopoulos/awpy-data/releases/tag/2000935)，下载日期为 2026-10-25。运行查看器不需要访问外网。

## 固定来源

- 项目：[pnxenopoulos/awpy-data](https://github.com/pnxenopoulos/awpy-data)
- Release：`2000935`，发布于 `2026-10-23T06:12:47Z`
- Release 指向的代码提交：`7c73907f74521d271f0eb40bcbe14a4912184e05`
- 游戏版本：ClientVersion `2000935`，PatchVersion `1.41.9.2`
- Steam build：`26144732`；SourceRevision：`11162119`
- 图片原包：[images.zip](https://github.com/pnxenopoulos/awpy-data/releases/download/2000935/images.zip)
- 原包 SHA-256：`217dec0b1f2203cc7e9f7bb1b9ef13873665f093203a7df7231b9eb0074b649e`，下载后已与上游 manifest 核对。
- 坐标原表：[map_data.json](https://github.com/pnxenopoulos/awpy-data/releases/download/2000935/map_data.json)
- 上游原始元数据保存在 `web/maps/upstream-map-data.json` 和 `web/maps/upstream-manifest.json`，应用使用转换后的 `web/maps/manifest.json`。

图片直接从原包解出，没有缩放、裁切或重绘；12 张 PNG 均已验证为 **1024 × 1024**。

## 坐标约定

与 [demoinfocs 的地图转换示例](https://github.com/markus-wa/demoinfocs-golang/blob/master/examples/map_metadata.go) 和 [Awpy 的 world_to_pixel 实现](https://github.com/pnxenopoulos/awpy/blob/afb1537f1e8cfe5ebcd54b29fb001707ab2bd5d2/crates/awpy-python/python/awpy/plot.py) 一致：

```text
pixelX = (worldX - posX) / scale
pixelY = (posY - worldY) / scale
```

雷达左上角为 `(0, 0)`，向右、向下为正，基准边长为 1024。将结果除以 1024 后可映射到任意大小的方形画布。原表的 `rotate`、`zoom` 不参与这套固定全图投影，遵循上游 `world_to_pixel` 的处理方式。

| 地图 | posX | posY | scale | 下层条件 |
| --- | ---: | ---: | ---: | --- |
| Mirage | -3230 | 1713 | 5 | — |
| Inferno | -2087 | 3870 | 4.9 | — |
| Dust II | -2476 | 3239 | 4.4 | — |
| Nuke | -3453 | 2887 | 7 | `z < -495` |
| Ancient | -2953 | 2164 | 5 | — |
| Anubis | -2796 | 3328 | 5.22 | — |
| Vertigo | -3168 | 1762 | 4 | `z < 11700` |
| Overpass | -4831 | 1781 | 5.2 | — |
| Train | -2308 | 2078 | 4.082077 | `z < -50` |

上下层共享 X/Y 标定；`lowerMaxZ` 来自原表 `verticalsections.lower.AltitudeMax`，等于阈值时归上层。

## 版本与归属

雷达图只对应上述固定游戏版本。旧 Demo、未来更新或创意工坊重制地图可能与底图不完全一致；查看器不按 Demo 构建版本自动选择历史雷达。未列入 manifest 的地图应使用自适应坐标网格，避免套用不匹配的底图。

按 [awpy-data 的授权说明](https://github.com/pnxenopoulos/awpy-data#licensing)，其构建脚本采用 MIT，但提取的游戏图片及 overview 数据仍属于 **Valve Corporation**，受 Valve 的版权与条款约束，不能将这些资产标为本项目的 MIT 作品。本地收录保留此来源说明；本项目与 Valve 没有关联或背书。
