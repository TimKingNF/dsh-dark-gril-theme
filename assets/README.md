# assets

背景视频素材。

## 规格

| 项 | 值 |
| --- | --- |
| 数量 | 22 段 |
| 容器/编码 | WebM / VP9 |
| 分辨率 | 2560×1392 |
| 帧率 | 24 fps |
| 时长 | 3.084 s（acting、speaking）/ 6.000 s / 6.042 s 三档 |
| 体积 | 单段 3.1–6.4 MB，合计 127 MB |
| 色彩 | yuv420p，`color_range=tv`，bt709 |

## 文件与状态的对应

文件名即 `lib/pools.js` 里的键，一一对应，改文件名会同时影响 host 与页面侧：

| 桶 | 文件 |
| --- | --- |
| idle（新会话） | `idle.webm` |
| idle（非新会话） | `idle.webm` `done.webm` `done-soft.webm` `done-confirm.webm` |
| thinking | `thinking.webm` |
| speaking | `speaking.webm` + `speaking-{neutral,explain,emphasis,confident,confirm,curious,happy,playful,surprised,thoughtful,warm}.webm` |
| acting | `acting.webm` |
| approval | `approval.webm` `listening.webm` `listening-focus.webm` `listening-nod.webm` |
