# 执行计划：按 DSH 状态切换背景视频（Web 插件）

状态：待用户批准（2026-11-14 首版；2026-11-15 按 m00736 / m00843 重写）。本文件只是计划，未开始编码。

## 0 目标与边界

**做**：一个 DSH Web 插件。视频在前两栏（左侧边栏 + 对话区）清晰呈现，第三/第四栏用磨砂透出——同一段视频被打磨、压暗，并带一道来自右下的暖光渐变，让工作台接住人物旁边的空间而不是贴一块黑板；按会话执行状态切换素材（5 态）；提供总开关与快捷键；素材缺失或解码失败自动退回原生背景。

**2026-11-15 修订（m00843）**：
1. 状态监听与切换**只照抄 `dsh-live2d-pets` 的事件，不新增自创事件**。
2. 最终视觉＝「只左中清晰 + 后续栏位磨砂透出 + 渐变光源」；原「全铺」「硬裁」降级为调试选项。
3. 阶段重划：阶段一只做「基本样式 + 固定视频」，先把主题 UI 定下来，状态机往后放。

**不做**：不做 stale 枚举（DSH 无此状态）；不做 speaking/error 态的视觉（无素材/无信号）；不改宿主 node_modules 源码；不改 dsh-better-sidebar 的代码（只做视觉覆盖）；不做移动端；不做多主机同步。

## 1 视觉定稿（原型 v7，2026-11-15 02:21）

**右栏没有素材可用（m00907 原话：「右侧边栏这里没有现成的背景可以提供，需要你自己实现对应的效果」）**，所以第三/四栏是一块自建磨砂玻璃，光源靠一层 overlay 模拟，不是 backdrop-filter。

- 视频层：`.stage` 铺满 `.app`，`object-fit:cover`，`object-position` 默认 78% 40%；右边界按栏数裁到第三栏左边（n3 → `right: var(--w1)`，n4 → `right: calc(var(--w1) + var(--w2))`，n2 → 0）。右栏底下确实没有视频。
- 前两栏：不加模糊，只叠阅读遮罩 —— 侧栏 48% / 对话 54%（全图最亮像素法，最差对比度 4.69 / 5.52，正文 #e6e6ec，对话过 AA）。
- 第三/四栏（玻璃本体）：竖向渐变 `linear-gradient(180deg, rgb(13,10,12) 0%, rgb(14,11,11) 40%, rgb(21,15,12) 64%, rgb(32,21,14) 83%, rgb(47,30,17) 100%)`，上冷近黑、下暖棕；内高光 `inset 1px 0 0 rgba(255,255,255,.07)`、`inset 0 1px 0 rgba(255,255,255,.045)`。数值对齐用户给的参考条带：顶部 (13,10,12)、底部 (47–49, 30–32, 17)。
- 光源：单个 `.glow` 覆盖**整个右侧区**（跨第三、第四栏，锚在右区左下角，`left: calc(100% - w1 - w2)`），`radial-gradient(66% 64% at -2% 106%, rgba(226,152,88,.27), rgba(212,144,82,.10) 44%, transparent 80%)` + 左缘一道白色高光渐变。必须是一层跨栏 overlay：每栏各放一个会在栏边界重新起光斑，读成两张独立的板。
- 实测（4 栏，2900×1450）：底部左缘 (84,57,36)、中部 (52,34,21)、右缘 (44,28,17)，与参考的「左亮右暗、下亮上暗」一致。
- 调试选项：`?vid=frost`（视频全铺 + `backdrop-filter: blur(42px)` 旧方案）、`?vid=full`（全铺仅压暗），保留作对照，不作默认。

## 2 状态源：照抄 dsh-live2d-pets，不自己发挥

参考实现 `dsh-live2d-pets@0.3.0` `package/src/service.ts`（236 行未压缩 TS），五个订阅位于 `:88-112`：

| 订阅 | 用途 | 我们映射 |
|---|---|---|
| `ctx.on('agent/status', …)` | `running` → thinking；`idle` → idle（done 保持期内不打断） | thinking / idle |
| `ctx.on('agent/error', …)` | 出错 | 只记日志，不切视频（无素材） |
| `ctx.on('agent/turn-stopping', …)` | 一轮结束 | done（三档见 §3） |
| `ctx.on('approval/request', (_req, next) => …)` | 待审批 | approval |
| `ctx.on('session/event', …)` (`deliverables/presented`) | 交付庆祝 | 本插件不用 |

三条必须照抄的坑（原实现里都有注释）：
1. `approval/request` 是 **waterfall**，必须 `return next()`，否则整条审批链卡死（`service.ts:105-108`）。
2. `agent/turn-stopping` 里若处于保持态要先判断，避免紧跟的轮次结束打断庆祝（`service.ts:94-96`）。
3. done 用 `DONE_HOLD_MS = 3500` + `setHeld()` 保持，且保持期到达的 `idle` 必须吞掉，否则 done 只存在一帧（`service.ts:63`、`:128-134`）。

**架构决定**：状态机放 **host**（`ctx.on` 只有 host 侧能拿到），client 不订阅事件流。host 维护 `{state, version}`，通过 `/state-video/events`（SSE）推送，失败降级为 1s 轮询 `/state-video/api`。理由：客户端侧没有对等的事件总线，硬凑要绕 dsh-client-ui-session 的内部 API，升级即碎。

另一条待实测：`agent/status` 的 payload 只带 `status`，不带会话身份；「任意会话在跑就演 working」需要自己维护运行中会话计数（若无会话字段，退化为「任一 running 即 thinking，全部 idle 才回 idle」）。

## 3 状态规格（沿用已裁决项）

| 态 | 触发（白名单） | 素材 | 驻留 / 退出 |
|---|---|---|---|
| idle | 启动；done 演完 5s；无 running 且无 pendingInteraction | idle + listening ×3 轮播（45s 换段） | 被 thinking 打断 |
| thinking | `agent/status` running；`step/start`；`tool/result` | thinking.webm | ≥3s，被 acting 切走 |
| acting | `tool/call` | acting.webm | ≥3s，到 tool/result |
| approval | `approval/request` | approval.webm | 可硬切打断任何态；decided 后回 thinking/acting |
| done | `agent/turn-stopping` | 有 approval/decided→done-confirm；本回合无 tool/call→done-soft；其余→done | 固定 5s 回 idle |

其他定值：交叉淡入 400ms（新层 `canplay` 后再淡入，旧层立即 pause + 清 src）；最小驻留 3s；素材放 `$DSH_HOME/profiles/web/assets/state-videos/`（同步脚本 + sha256 校验，摆脱对 Downloads 的依赖）；开关＝设置页总开关 + Ctrl+Alt+B。

## 4 事实基线

- 素材：`/mnt/c/Users/TimKing/Downloads/object-live-states`，22 个 webm，22 个不同哈希，VP9 2560×1392 24fps，3.084–6.042s，合计 127MB。
- `SessionStatus` 只有 running / pendingInteraction / completionUnread（`dsh-client-ui-session/lib/types/client/index.d.ts:30-36`），无 stale。
- 全生态 4392 条扫过，**没有**「状态→背景视频」的插件；状态机层已有成熟实现（见 §2）。
- 可照抄的 Range/206 路由：`dsh-video-skin@0.1.6` `index.js:118-186`、`createReadStream` `:167/185`、`webServer.register` `:286/314`。
- 本机从 /mnt/c 读 6MB webm 0.01–0.03s。

## 5 阶段划分（按 m00843 重划）

| 阶段 | 交付 | 验证 | 回退点 |
|---|---|---|---|
| **S1 主题与固定视频** | 插件包骨架 + host 两条路由（素材清单 / Range 文件）+ client 铺视频层（固定播 `idle.webm`，无状态机）+ 前两栏遮罩 + 第三/四栏磨砂透出（含整屏暖光）+ 双/三/四栏自适应 + 一个临时开关按钮 | 真 GUI 里三栏、四栏截图与 `prototype/v5-*.png` 并排比对；开关关闭后 DOM 无 `<video>`、无 rAF | 视觉不达标 → 回原型调参数（不写状态机、不做安装） |
| **S2 状态机** | host 状态机（照抄 §2 五订阅）+ 5 态 + 3s 驻留 + done 三档 + 5s 回落 + 吞 idle + SSE/轮询端点；client 双 video 交叉淡入 + 幂等切源 | node 单测跑事件序列断言时间线；真机抓 5 态截图 | 多会话计数口径不明 → 先单会话，日志记录差异 |
| **S3 设置与开关** | 设置页总开关 + Ctrl+Alt+B + 素材同步脚本（sha256）+ 缺失/解码失败兜底 | 关开关后逐像素回原生；删素材后自动禁用并 console.warn | `dsh plugin remove` + 删 assets |
| **S4 脚本化验收** | `scripts/verify-state-video.mjs`：受控回合触发 5 态，产状态日志 + 每态截图 + 第三栏取色证明磨砂生效 + 栏边界对齐测量 + rAF 帧时间 + 残留检测 → `reports/state-video-verify.md` | 五项可重放 | approval 无法脚本触发 → 半自动抓拍并标注 |
| **S5 打磨（可选）** | 4K 双路性能、idle 轮播换段、README 与卸载说明 | 帧时间 p95 ≤ 16.7ms | 素材转码 1600×900 备用版 |

工时：S1 2.5–3h；S2 2h；S3 1h；S4 1.5h；S5 1h，合计 8–8.5h（不含等待确认）。

## 6 编码前仍需查清（只读，不阻塞 S1）

| # | 未知点 | 状态 | 查法 |
|---|---|---|---|
| U1 | 客户端订阅事件流的 API | **已解决**：不走 client 事件流，状态机放 host | — |
| U2 | 插件设置页注册方式 | 待查（S3 前） | 读 client-ui-* 里注册 settings 的插件壳 |
| U3 | dsh-better-sidebar 工作台实际背景 alpha 与 z-index | 待查（S1 中） | 在真 GUI 读 DOM + 计算样式（只读） |

## 7 风险与对策

| 风险 | 触发条件 | 对策 |
|---|---|---|
| 双路 4K VP9 无硬解 | 淡入 400ms 内 rAF >16.7ms | 新层先播 1 帧再删旧层；或转码 1600×900 备用 |
| `backdrop-filter` 吃 GPU | 第三/四栏面积大、4K 视频逐帧重算模糊 | 允许把模糊降到 24px 或改用「预模糊第二视频层」；实测 frame time 再定 |
| 切源黑屏 | 新 src 未 ready 就切 opacity | `canplay` 后才淡入，最多等 300ms，超时保持旧层 |
| 磨砂把视频压成灰片 | 素材偏亮 | 用全图最亮像素算对比度定下限；必要时换更暗素材 |
| 状态抖动 | step 级事件密集 | 3s 最小驻留 + thinking↔acting 只在 tool/call 边界互切 |
| 与已有壁纸层打架 | 以后装 dsh-wallpaper-bg 等 | 视频层固定最底 + `z-index` 配置项 |

## 8 需要你参与的节点

1. **S1 观感确认**（最重要，一票否决权）。
2. **S3 安装授权**（写 web profile：加本地插件 + 127MB assets）。
3. **S4 验收结论**。

## 9 原型状态（2026-11-15）

- 文件：`prototype/layout-prototype.html`（v7，默认 `vid=left` 硬裁 + 自建玻璃 + 整屏光源）；备份 `_v5-备份.html`、`_v4-备份.html`、`_v3.1-备份.html`、`_v3-初版.html`。
- 出图：`prototype/v7b-3col.png`、`v7b-4col.png`（2900×1450）；v3–v6 系列保留作对照。
- 栏宽（1450 基准）：侧栏固定 176px；三栏工作台 34%；四栏 24% + 20%；双栏只剩侧栏 + 对话。
- 出图命令：`google-chrome --headless=new --disable-gpu --no-sandbox --user-data-dir=/tmp/cp-x --hide-scrollbars --force-device-scale-factor=2 --window-size=1450,725 --screenshot=… "file://…/layout-prototype.html?layout=3|4&vid=frost|left|full"`；缺 `--user-data-dir` 会静默不出图。
