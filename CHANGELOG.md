# 变更记录

## 0.1.0 — 2026-11-15

首个可发布版本。功能按修订号累积，细节在 `docs/status.md`。

- **五态状态机**：idle / thinking / acting / approval / done。信号取自 `agent/status`、
  `agent/assistant-stream`、`tools/execute`、`approval/request`、`user-questions/request`。
- **22 段素材、六个桶**：thinking 13 段（含 12 段 speaking 素材）、acting 4 段
  （acting + listening 三段）、approval 4 段（approval + 同三段 listening 共用）、
  done 3 段、idle 4 段、新会话 idle 单段。
- **边界才能换片**：素材完整播完才切，播放中不做硬切；双 video 交叉淡入、提前 1.2s 预载。
- **dark / beautify 双模式**：`Ctrl+Alt+M` 原地切，两个模式只差三档观感变量。
- **设置页**：DSH 设置 →「Dark Gril 主题」，打光模式与调试浮窗两个开关，写的是同一份配置。
- **调试浮窗**：可拖动、可折叠，显示在听什么状态、在演哪段、下一段预载、桶进度与事件流水。
- **配置单一真相源**：`$DSH_HOME/dsh-dark-gril-theme.json`，坏键坏文件一律退化成默认值。
- **素材不随包发**：从 GitHub 的 `assets` 分支下载后放到 `$DSH_HOME/dsh-dark-gril-theme/assets/`。

### 整理（未生效于功能，见提交记录）

- 轮播规则只留 `lib/pools.js` 一份：`pickNext` 以函数源码注入页面，桶名由宿主算进快照。
- 删掉 `machine.feedChunk` 死接口，`agent/assistant-stream` 的 chunk 帧不再参与判定。
- 素材白名单按目录 mtime 缓存，不再每个视频请求扫一次盘。
- 配置写接口补两道门：只收 `application/json` 正文，且 Origin 与 Host 不一致回 403。
