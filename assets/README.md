# assets

背景视频素材。**不随包发**，存在仓库的 `assets` 分支，自己下载到
`$DSH_HOME/dsh-dark-gril-theme/assets/`（详见根目录 README 的「素材」一节）。

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

## 文件与桶的对应

文件名即 `lib/pools.js` 里的键，一一对应，改文件名会同时影响 host 与页面侧：

| 桶 | 文件 |
| --- | --- |
| idle（新会话） | `idle.webm` |
| idle（跑过回合） | `idle.webm` `done.webm` `done-soft.webm` `done-confirm.webm` |
| done | `done.webm` `done-soft.webm` `done-confirm.webm` |
| thinking | `thinking.webm` + `speaking.webm` 与 11 段 `speaking-{neutral,explain,emphasis,confident,confirm,curious,happy,playful,surprised,thoughtful,warm}.webm` |
| acting | `acting.webm` `listening.webm` `listening-focus.webm` `listening-nod.webm` |
| approval | `approval.webm` + 同三段 `listening-*.webm`（与 acting 共用，归属不互斥） |

`speaking` 已经不是状态（修订 #10）：12 段 speaking 素材并进 thinking 桶随机重播。
