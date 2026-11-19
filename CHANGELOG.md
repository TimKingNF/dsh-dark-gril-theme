# 变更记录

## 0.2.0 — 2026-11-20

换片过程重做：从「两段同时半透明」改成「同一像素任何时刻只显示一帧」，并修掉三处会把换片做坏的实现缺陷。

### 换片过渡（新增）

- **三种过渡，任一种都不重叠两段画面**：`cross` 直接叠淡（默认）、`dip` 压暗盖住再揭、`blur` 失焦。
  之前的交叉淡入会让两段素材里位置不同的同一个人同时半透明，肉眼读成「两个影子」，靠调时序消不掉。
- **`dip` 两段时长可配**：`dipInMs`（盖，默认 250）/ `dipOutMs`（揭，默认 400），设置页两条滑块 0–1200ms，
  `Ctrl + Alt + T` 轮换过渡方式。
- **`blurMs` 可配**：失焦总时长，默认 600，0–2000ms。
- 「柔边擦除」试过两版（`mask-image` 扫过、外层 `clip-path` 扫过）后**下线**：横贯画面的大硬边观感被否。

### 修复

- **换片瞬间黑一下** → 新元素在 `canplay` 时就参与混合，而首帧尚未提交给合成器。
  改为「新元素先在不透明但在下层垫好，等 `requestVideoFrameCallback` 确认真有帧呈现才淡出旧元素」，
  并显式规定叠放顺序（`data-top`）。20 段素材、1200 帧采样：两层同时不可见的帧数为 0。
- **换片闪一下（仍存在）** → 换片由 `ended` 触发，而 `ended` 时刻浏览器不保证元素上还留着哪一帧。
  改为提前 `BOUNDARY_LEAD_MS` 用 rAF 盯 `duration - currentTime` 主动换片，`ended` 降级为兜底。
  3000 帧采样：可见元素处于 `ended` 状态的帧数为 0。
- **失焦效果播完就停住** → 预载路径下 `canplay` 可能在监听挂上之前就发过，`commit()` 永不执行、`advancing` 卡住。
  改为 `commitOnce()` 三路兜底（事件 + 1200ms 定时 + `readyState >= 2` 同步检查），另加 `playSafe()` 与停顿看门狗。
- **失焦时人物放大再缩回** → 模糊靠 `transform: scale(1.04)` 遮边缘透明缝，而这条 transform 进了过渡，
  旧段 1.00→1.04、新段已 1.04 再回 1.00。改为静态外扩 24px（`#dgt-stage` 本身 `overflow: hidden`），
  过渡期不再有任何 transform。
- **设置改了报 `no-valid-key`** → 跑着的 DSH 进程里还是旧模块。错误提示改成可照做的中文说明（改完必须重启宿主）。

### 默认值变更（升级后观感会变）

- `transition` 默认 `cross`（原来是 `dip`）。
- `glow` 默认 `0`（不打光）；`Ctrl + Alt + M` 切到 `beautify` 即恢复打光。
- **设置页每次改动都立即落盘**：原来只有设置卡片那条路径会写配置，页面内改完一刷新就回默认。
  五个入口（观感、过渡、压暗/揭开时长、失焦时长、调试浮窗）全部改为 `persist: true`。

### 已知取舍

- `dip` 的遮盖峰值刻意停在 0.879 而非 1：留 12% 可见度让过渡是「化开」，不是「闪黑」。
- `blur` 的静态外扩让 cover 取景比原来约大 2%。
- `wipe`、`wipeMs` 已从代码与校验规则里删除；旧配置文件里残留的 `wipeMs` 会在下次写盘时被丢掉。

### 测试

`npm test` → 52 pass / 0 fail（新增默认值与枚举校验用例）。

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
- **许可**：GPL-3.0-or-later，全文见 [LICENSE](LICENSE)。

### 整理（未生效于功能，见提交记录）

- 轮播规则只留 `lib/pools.js` 一份：`pickNext` 以函数源码注入页面，桶名由宿主算进快照。
- 删掉 `machine.feedChunk` 死接口，`agent/assistant-stream` 的 chunk 帧不再参与判定。
- 素材白名单按目录 mtime 缓存，不再每个视频请求扫一次盘。
- 配置写接口补两道门：只收 `application/json` 正文，且 Origin 与 Host 不一致回 403。
