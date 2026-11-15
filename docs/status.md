# 进度总结

> 快照：2026-11-15 14:25（Asia/Shanghai）。提交 `8667280`（基线 tag `s1-baseline` = `d6511fb`）。规格修订 #6

## 一句话状态

**阶段二（状态机 + 桶轮播）已实现并跑通**：host 侧订阅 `agent/status` / `agent/assistant-stream` / `tools/execute` / `approval/request`，算成 5 态推 SSE；client 侧双 video 交叉淡入、整段播完才换、桶内不连续重复、acting 与底层交替，另有 `dark`/`beautify` 双观感与调试浮窗。22 段素材全部进桶。**还没做的只有真机安装与 host→SSE 端到端**：目前所有换态都是 `setState()` 假快照驱动的。

## 目标与边界

- 目标：DSH Web GUI 的背景视频按 Agent 执行状态切换（idle / thinking / speaking / acting / approval）。22 段素材全部进桶。
- 视觉：视频只铺「左侧栏 + 对话区」；第三栏起自建不透明玻璃（竖向渐变 + 一盏跨栏光源），第五、第六栏自动同款。
- 不做：不改 DSH 原生代码、不打补丁到宿主 `node_modules`、不侵入右栏内容区（只画它背后的层）。

## 已完成

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 插件骨架（bundle patch + 注入行 + 路由） | 完成 | `index.js`、`cordis.patch.yml` |
| 素材路由 Range/206 与白名单 | 完成 | `lib/route.js`，`tests/host.test.mjs` 覆盖 200/206/416/HEAD/404 |
| 左中视频铺满（视口原点、列底色/分隔线让位） | 完成 | `runtime/bg.js` `applyLayout()`、`clearColumnBackgrounds()`、`clearColumnBorders()` |
| 尺寸跟随窗口（CSS cover + 三条监听） | 完成 | stage 宽度随布局变化 1943→2583→1943 实测 |
| 右侧玻璃 + 32px 收边 + 跨栏光源 | 完成 | `runtime/bg.css` `#dgt-sheet` / `#dgt-seam` / `#dgt-glow` |
| 深色主题强制与还原 | 完成 | `ensureDark()` / `restoreDark()` |
| 真 DOM 联调（未装插件） | 完成 | 3099 dev server + 页面注入，`readyState 4` |
| S2 宿主状态机（5 态 + seq + 变化才推） | 完成 | `lib/machine.js`、`lib/state-service.js`；`tests/machine.test.mjs` 12 例 |
| S2 桶表与不连续重复抽签 | 完成 | `lib/pools.js`；`tests/pools.test.mjs` 8 例 |
| S2 状态通道（SSE + JSON 快照，失败转 1s 轮询） | 完成 | `index.js` `STATE_ROUTE`/`STATE_JSON_ROUTE`；SSE 带 `retry: 2000` 与 25s 心跳 |
| S2 播放层（双 video 桶轮播 + acting 交替） | 完成，假快照验过 | `runtime/bg.js` `playClip()` / `decideNext()` / `takeNext()`；`assets/` 已备齐 22 段 |
| 预加载（剩余 1.2s 预热到另一 video 元素） | 完成 | `warmNextClip()` / `timeupdate`；实测换片后 50ms 内 `currentTime` 已在走 |
| 观感双模式 dark / beautify | 完成 | `DIM_MODES` + `applyMode()`，只改 CSS 变量；`Ctrl+Alt+M` |
| dark 模式光斑与玻璃色阶一起压暗 | 完成 | `DARK_RAMP` + `--dgt-glow`；左下角 p50 31.5→24.7 |
| 调试浮窗（快照态 / 正在演 / 桶序 / 预载 / 源 / seq） | 完成 | `startDebug()` / `renderDebug()`，`CONFIG.debug` 为真时挂 `#dgt-debug` |
| 联调捷径 | 完成 | dev server 新增 `/config.json` 与 `/inject.js`，控制台一行注入 |

测试：`node --test "tests/*.test.mjs"` → 23/23（host 3 + machine 12 + pools 8）；`node --check index.js lib/*.js runtime/bg.js` 通过。

## 已定稿的规格（S2 直接照做）

> 修订 #2 · 2026-11-15 11:45。依据「素材必须完整播完再切」+ 全桶随机轮播改写。修订 #1 中三条作废：①`done` 作为独立态 ②最小驻留 3s ③`tool/call` 作为 acting 边界。旧文见 `git log -p docs/status.md`。

> 修订 #3 · 2026-11-15 12:40。接缝收窄。开右侧边栏时 `videoRight` 落在两栏之间，原 220px 压暗带在深色画面上就是一条可辨的暗带（用户 12:31 截图指出「一道明显的明暗分界」）。改：`SEAM_WIDTH` 220→32、`GLOW_LEAD` 200→32、`#dgt-sheet` 左缘 `inset 1px 0 0` 高光删除、sheet 左移 2px 压住亚像素缝、新增 `clearEdgeBorder()` 按坐标抹掉右栏面板自带的 `border-left`（不猜 CSS Module 类名）。注意它必须用 `elementsFromPoint` 扫：这条边框挂在**兄弟节点**上，交界点本身是个透明的拖拽把手，从交点往祖先走永远找不到它——第一版就是这么漏掉的，肉眼看仍是一根从顶到底的白线。

**状态词表（5 态）**：`idle` / `thinking` / `speaking` / `acting` / `approval`。
`done` 不再是独立态，三段素材并入 idle 池；`error` 留接口不启用。

**态 → 轮播桶**（22 段全部投用）

| 态 | 桶内容 | 段数 | 单段时长 s |
| --- | --- | --- | --- |
| idle（新会话） | `idle` | 1 | 6.00 |
| idle（非新会话） | `idle` `done` `done-soft` `done-confirm` | 4 | 6.00 / 6.00 / 6.04 / 6.04 |
| thinking | `thinking` | 1 | 6.00 |
| speaking | `speaking` + 11 个 `speaking-*` | 12 | 3.08 / 6.04×11 |
| acting | `acting` | 1 | 3.08 |
| approval | `approval` `listening` `listening-focus` `listening-nod` | 4 | 6.00 / 6.00 / 6.04 / 6.04 |

新会话 = 该会话尚无任何 `turn/start`（hero 空白态）。跑过第一个回合后永久使用非新会话池。

**轮播规则（所有桶）**

1. 一段必须完整播完才切。`<video>` 不设 `loop`，用 `ended`（或 `duration − 0.4s` 预起下一段）。
2. 边界时刻读**最新**状态决定桶。`pendingState` 是覆盖式不是队列，中间经过的态全部丢弃。
3. 桶内随机抽取，**不连续重复**：记住上一段 index，抽中则重抽一次。
4. 边界时状态没变也换桶内下一段，绝不 seek 回 0。
5. 桶只有 1 段（thinking / acting / idle-新会话）时 `ended` 后换新 video 元素从 0 播，避免 seek 抖动。

**态判定优先级**（host 侧，自上而下）

1. `approval/request` 未决 → `approval`，硬切，可打断当前段。
2. 前台工具 `tools/execute` 持续 ≥3s → `acting`（只在边界生效，见下）。
3. `text-delta` 流 → `speaking`。
4. `reasoning-delta` 流；或 `agent/status:running` 但无细信号 → `thinking`。
5. 其余 → `idle`。

**acting 插入规则**

- 触发条件：当前会话最近一个已 start、未 end 的 `tools/execute` 连续运行 ≥3s。
- 时机：等当前段播完再插，不打断中途。
- acting 播完：工具仍在跑 → 回上一层桶按不连续重复抽一段；工具已结束 → 按最新态定桶。
- 回到上层后工具仍未结束且新段播完 → 再插 acting，交替直到工具结束。
- 阈值在边界处判定，所以 <3s 的工具永不上屏。实测 p50 0.33s、95% 在 3.08s 内，多数回合看不到 acting——这是设计后果，不是 bug。

**聚合参数**（`agent/assistant-stream` 逐 chunk 发射，未节流，必须自聚合）

- host 侧 16ms 合帧，SSE 推送上限 10Hz。
- `text-delta` 连续 ≥300ms 或 ≥8 个 chunk → `speaking`；`reasoning-delta` 同规则 → `thinking`。
- 交叉淡入 400ms。

**已知取舍**

- done 三档语义消失：不再区分「有审批 / 无工具 / 其余」，四段全随机。
- speaking 的结构判据（工具后汇报→confirm、首段→explain）让位给随机轮播，12 段全用，语义变弱。
- 最小驻留 3s 删除，驻留由素材时长本身承担。
- 预载提前量 1.2s（`timeupdate` 里 `duration - currentTime <= 1.2` 触发预热）：本机 canplay 约 0.2s，留量是为了慢盘与首轮冷缓存。

> 修订 #4 · 2026-11-15 13:06。观感双模式。用户 12:56 要求「恢复原来的肤色打光，能在 dark 和 dark-beautify 之间切换对比」。加 `DIM_MODES`（`dark` 侧 0.48 / 对话 0.54；`beautify` 全 0）与 `applyMode()/readMode()/toggleMode()`，只改 `--dgt-side-dim` / `--dgt-conv-dim` 两个变量，不动 DOM、不重编码素材，切换瞬时且可逆。默认 `dark`，选择写 `localStorage['dgt-mode']`，快捷键 `Ctrl+Alt+M`，调试浮窗首行显示当前模式。**已知代价**：`beautify` 下对话列零遮罩，文字直接压在人物上，长回复的可读性要人眼判。

> 修订 #5 · 2026-11-15 13:42。光斑范围与衰减。用户 13:26 指出左下光斑「是一个圆形从左下角向外扩散」，要求范围略扩大、明暗过渡更自然，并给了标线（面板宽的 ~25%、高的 ~19%）。改法两件：①主光斑 `30% 23% at 6% 103%`（原 30% 26% at 8% 104%，圆心更低更左，让可见部分落在标线内）；②三档换五档（0.26 / 0.185 / 0.12 / 0.055 / 0），再叠一层 `40% 30% at 2% 101%`、峰值 0.085 的宽铺垫拖长尾巴——圆形边界感来自两档之间跨度太大，改成近似指数衰减后，底边横扫的最大相邻落差从 12 级降到 6 级/25px。实测（1299px 宽截图）：亮度回到基线 +2 的位置占面板宽 30%、高 15%。

> 修订 #6 · 2026-11-15 13:59，14:15 改。光斑跟模式一起变暗。用户 13:51：「切到 dark 时把侧边栏光斑也调暗，和对话区蒙版一致」，14:01：「还要再暗一点」。
> 第一版只动 `DIM_MODES.dark.glow`（0.46）。实测发现这一项几乎不起作用：同一帧、面板左下角同一块，0.46 → 0.10 只让均值从 35.8 掉到 34.2，因为那块亮度八成来自玻璃色阶自身的底端暖色（`rgb(47,30,17)`，亮度约 32.7），光斑只占小头。
> 所以第二版补了真正的杠杆：`DIM_MODES.dark` 挂一条更暗的 `DARK_RAMP`，只压 83% 与 100% 两档（`rgb(32,21,14)`→`rgb(26,17,12)`、`rgb(47,30,17)`→`rgb(37,23,14)`），中上部不动；`applyMode()` 按模式写 `--dgt-sheet-ramp`，beautify 换回 CSS 原值（启动时 `BASE_RAMP` 拷一份）。色阶同一条变量，`#dgt-seam` 跟着一起暗，不会跟玻璃脱色。
> 结果：面板左下角同区域 p50 31.5→24.7、均值 35.8→29.5（−18%）。beautify 侧不变。
> `glow` 值定在 dark 0.25、beautify 1；「glow = 1 − conv」这条经验规则作废——它没抓住主要矛盾。

> 修订 #7 · 2026-11-15 14:35。定名、素材归位、内部命名统一。用户三条拍板：插件名确认；素材从原始目录**直接移动**进仓库；内部全局变量名统一。
> ①素材：22 段先逐个 sha256 比对目标 `assets/` 全部一致，再删掉源目录 `C:\Users\TimKing\Downloads\object-live-states`；仍由 `.gitignore` 排除，仓库只放代码，另写 `assets/README.md` 记规格与取用方式。
> ②命名：`__DSH_STATE_VIDEO_BG__`/`_API__` → `__DGT__`/`__DGT_API__`，`__SVB_INSTALLED__` → `__DGT_INSTALLED__`，`#svb-*` → `#dgt-*`，`.svb-video` → `.dgt-video`，`data-svb` → `data-dgt`，`--svb-*` → `--dgt-*`，`localStorage['svb-mode']` → `['dgt-mode']`，dev server 的 `svb-dev-style` → `dgt-dev-style`。共改 7 个文件、88 处；`docs/s1-report.md` 是阶段一的存档报告，保留旧名不动。
> ③验证：`node --check` 六个文件通过、`node --test` 23/23；dev server 重启后 `/inject.js` 里已是 `__DGT_API__`；浏览器新会话注入后 `__DGT_API__`/`__DGT__`/`__DGT_INSTALLED__` 均在、`#dgt-stage` 存在、2 个 `video.dgt-video`、`#dgt-debug` 在、`data-dgt="on"`、旧 `#svb-*` 残留 0 个；计算样式核对 `#dgt-sheet` 用的是 dark 色阶（`rgb(37,23,14)` 收尾）、`--dgt-glow: 0.25`、`--dgt-conv-dim: 0.54`、`#dgt-seam` 宽 32px、`.dgt-video` 的 `object-position` 生效。

**架构**：状态机放 host（`ctx.on` 只在 host 侧可用），host 只推**态名 + seq + time**；桶映射与轮播在 client（`runtime/bg.js`）。SSE 失败降级 1s 轮询。

**状态源**：`agent/assistant-stream` + `tools/execute` + `approval/request`（waterfall，必须 `return next()`）+ `agent/status` / `uiSession.sessionStatus`（兜底纠偏）。

**开关**：设置页总开关 + `Ctrl+Alt+B`；观感 `Ctrl+Alt+M`（dark ↔ beautify）；素材缺失/解码失败自动禁用并回原生外观；桶内缺某一段时从桶里摘掉，摘空则该态并入 idle。

## 关键数字（实测/自算）

- 素材：VP9 2560×1392、24fps、单段 5–6MB、22 段共 127MB。
- 玻璃色阶：dark `rgb(13,10,12)` → `rgb(37,23,14)`（83% 处 `rgb(26,17,12)`）；beautify 用 CSS 原值 `rgb(13,10,12)` → `rgb(47,30,17)`。光源峰 `rgba(226,152,88,·)`。
- scrim：侧栏 0.48 / 对话 0.54；最差对比度 4.69 / 5.52（正文 `#e6e6ec`），对话过 AA。
- 接缝：32px 软接边（原 220px）。开右侧栏时右栏左缘曾经有一根 1 设备像素白线（`border-left: 0.666667px rgba(255,255,255,0.2)`，+23 亮度），现由 `clearEdgeBorder()` 抹平，逐像素复测两侧回到 20/17/16。
- 整屏铺满需放大 1.5×（1920×1080 级窗口），这是素材分辨率上限，不是排版选择。

## 已知限制

1. **还没真装**：沙箱内 `dsh plugin add` 恒报 `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK … Read-only file system`，`dsh web --help` 也会写 `~/.dsh/profiles/web/cordis.yml` 被拒。目前靠「dev server + 页面注入」验收，真安装要等 S3 且需扩权。
2. **拖窗口尺寸没亲手验过**：`bsk` 的外层窗口 resize 被播放中的视频挡住（`media source changed`），只验了布局变化下的跟随链路。
3. **后台窗口解不出视频帧（已查明，非代码问题）**：Agent Window 默认后台打开时 `document.visibilityState` 为 `hidden`，Chrome 推迟媒体加载，`<video>` 恒停 `readyState 0`、事件只有 `loadstart → stalled`；同一 URL 的 `fetch` 仍是 206/59ms，同页 `curl` 5.4MB/52ms。**bsk 验收必须 `bsk_session start … noFocus:false` 开在前台窗口**，否则会把测试环境当成代码故障。
4. **截不到 docked 三/四栏**：本机 dsh-better-sidebar 是浮动模式，网格第三列恒为 0。
5. **右栏那道 1px 白边靠 DOM 现状抹除**：它来自宿主面板的 `border-left: 0.666667px rgba(255,255,255,0.2)`（DPR 1.5 下正好一个设备像素、+23 亮度）。`clearEdgeBorder()` 每次布局按坐标重扫并置 0，宿主若改用它法画边（box-shadow / 伪元素 / 背景图），这里要跟着改。
6. **host→SSE→client 没端到端跑过**：主机侧状态机、SSE 路由、client 消费三段各自验过（单测 / dev server `/config.json`+`/inject.js` / 页面里 `setState()` 假快照），但没有一次真实的 Agent 回合经 SSE 推过来驱动换态。装插件后第一件事就是跑这个。
7. **`beautify` 下长文可读性未人眼判**：对话列零遮罩，文字直接压在人物上，只有用户主观能定。

## 提交记录

| 提交 | 内容 |
| --- | --- |
| `d6511fb` | 阶段一：固定视频背景 + 左中铺满 + 右侧自建玻璃（tag `s1-baseline`） |
| `1a6df31` | docs：进度总结首版 |
| `316b8bd` | 阶段二：状态机 + 桶轮播 + 预加载 + 调试浮窗（含 32px 接缝修复与 1px 白边抹除） |
| `a00ae6b` | 观感双模式 dark / beautify |
| `9a014a2` + `b42468f` | 光斑范围与衰减（五档 + 宽铺垫），docs 修订 #5 |
| `44b452c` | 光斑随模式变暗（第一版，只动 `--dgt-glow`） |
| `8667280` | 取代上一条：dark 专用暗色阶才是真正的杠杆，glow 定 0.25 |

## 下一步

| 阶段 | 内容 | 预估 | 出口判据 |
| --- | --- | --- | --- |
| ~~S2~~ | ~~host 状态机 + SSE 推状态 + client 桶轮播与 acting 插入~~ **已完成** | 完成 | 假快照下 5 态、整段播完、桶内不重复、acting 交替均已验；真回合端到端见下一行 |
| S2.5 | 真装插件（`dsh plugin --profile web add`）+ 真实回合端到端 | 0.5h | 一次真实回合能在页面上看到 thinking→speaking→idle 的自动切换；`/state` SSE 连上且不断流 |
| S3 | 设置页开关 + `Ctrl+Alt+B` + 配置文件 | 1h | 关掉后无残留、刷新后状态保持 |
| S4 | 脚本化验收（5 态截图 + 右栏取色 + 帧时间 + 残留检测） | 1.5h | 脚本一条命令出报告 |
| S5 | 打磨（光斑与人物过渡、素材缺失兜底文案） | 1h | 用户主观通过 |

## 已拍板（原待定三条，2026-11-15 14:30）

1. **插件名**：`dsh-dark-gril-theme` 为最终名，不改。
2. **素材归属**：22 段已从 `C:\Users\TimKing\Downloads\object-live-states` **移动**进 `assets/`（原目录已清空删除，移动前逐个 sha256 校验与目标一致）。仍由 `.gitignore` 排除，不进 git——仓库只有代码，素材随工作区走。
3. **内部命名**：统一到 `dgt`。全局 `__DGT__`（配置）/ `__DGT_API__`（API）/ `__DGT_INSTALLED__`（幂等哨兵）；元素 `#dgt-stage` `#dgt-glass` `#dgt-sheet` `#dgt-seam` `#dgt-glow` `#dgt-scrim-side` `#dgt-scrim-conv` `#dgt-debug` `#dgt-video-a/b`；类 `.dgt-video`；属性 `html[data-dgt]` / `html[data-dgt-mode]`；CSS 变量 `--dgt-side-dim` `--dgt-conv-dim` `--dgt-glow` `--dgt-sheet-ramp` `--dgt-focus`；localStorage `dgt-mode`；dev server 注入的 style id `dgt-dev-style`。
