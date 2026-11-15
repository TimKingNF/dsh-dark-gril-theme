# 进度总结

> 快照：2026-11-15 15:45（Asia/Shanghai）。基线 tag `s1-baseline` = `d6511fb`。规格修订 #10（4 态重排：speaking 并入 thinking，listening 并入 acting）

## 一句话状态

**阶段二（状态机 + 桶轮播）已实现并跑通**：host 侧订阅 `agent/status` / `agent/assistant-stream` / `tools/execute` / `approval/request`，算成 4 态（idle / thinking / acting / approval）推 SSE；client 侧双 video 交叉淡入、整段播完才换、桶内不连续重复、acting 与底层交替，另有 `dark`/`beautify` 双观感与调试浮窗。22 段素材全部进桶。**还没做的只有真机安装与 host→SSE 端到端**：目前所有换态都是 `setState()` 假快照驱动的。

## 目标与边界

- 目标：DSH Web GUI 的背景视频按 Agent 执行状态切换（idle / thinking / acting / approval）。22 段素材全部进桶。
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
| S2 宿主状态机（4 态 + seq + 变化才推） | 完成 | `lib/machine.js`、`lib/state-service.js`；`tests/machine.test.mjs` 11 例 |
| S2 桶表与不连续重复抽签 | 完成 | `lib/pools.js`；`tests/pools.test.mjs` 8 例 |
| S2 状态通道（SSE + JSON 快照，失败转 1s 轮询） | 完成 | `index.js` `STATE_ROUTE`/`STATE_JSON_ROUTE`；SSE 带 `retry: 2000` 与 25s 心跳 |
| S2 播放层（双 video 桶轮播 + acting 交替） | 完成，假快照验过 | `runtime/bg.js` `playClip()` / `decideNext()` / `takeNext()`；`assets/` 已备齐 22 段 |
| 预加载（剩余 1.2s 预热到另一 video 元素） | 完成 | `warmNextClip()` / `timeupdate`；实测换片后 50ms 内 `currentTime` 已在走 |
| 观感双模式 dark / beautify | 完成 | `DIM_MODES` + `applyMode()`，只改 CSS 变量；`Ctrl+Alt+M` |
| dark 模式光斑与玻璃色阶一起压暗 | 完成 | `DARK_RAMP` + `--dgt-glow`；左下角 p50 31.5→24.7 |
| 调试浮窗 v2（拖动 + 五卡分栏 + 事件流水） | 完成，真机已验 | `runtime/bg.js` `startDebug()` / `renderDebug()`：标题条可拖动（位置存 `sessionStorage['dgt-debug-pos']`）、可折叠、五张卡（在听什么 / 在演什么 / 下一段 / 轮播桶 chips / 最近变化），`debugSet()` 定点更新 |
| 联调捷径 | 完成 | dev server 新增 `/config.json` 与 `/inject.js`，控制台一行注入 |
| S3 配置单一真相源 | 完成 | `lib/config.js`：白名单校验 + 同目录 tmp → rename 原子写；缺文件 / 坏 JSON 退化默认并 warn |
| S3 配置读写路由 | 完成 | `index.js` `CONFIG_ROUTE`：GET 回全量配置，POST 回 200 `{ok:true,config}` / 400 `no-valid-key` / 500 `write-failed`；请求体上限 64KB |
| S3 设置页（两个开关） | 完成，真机已验 | `client.js`：`settings.section` 顶层页「Dark Gril 主题」，打光模式 / 调试浮窗两个 `role=switch` 开关；账户菜单 → 设置 → 左栏「Dark Gril 主题」点进去可见、可点 |
| S3 快捷键与开关同源 | 完成 | `Ctrl+Alt+M` 与设置页开关都走 POST 落盘；页面内用 `dgt-config` 事件双向同步 |
| S3 观感不再写 localStorage | 完成 | 删掉 `dgt-mode`，模式只读 `$DSH_HOME/dsh-dark-gril-theme.json` |

测试：`node --test "tests/*.test.mjs"` → 31/31（host 3 + machine 11 + pools 10 + config 7）；`node --check index.js client.js lib/*.js runtime/bg.js` 通过。


## S3 配置层（修订 #7）

**一份配置，一个写入口。**

- 真相源：`$DSH_HOME/dsh-dark-gril-theme.json`（`DSH_HOME` 未设时 `~/.dsh/dsh-dark-gril-theme.json`）。缺文件即全用默认值，不预生成。
- 键白名单（`lib/config.js`）：`enabled` `asset` `sidebarDim` `convDim` `glow` `focusX` `focusY` `debug` `beautify`。类型或范围不符的键直接丢弃，不写盘；一次 patch 一个合法键都没有则整次拒收（HTTP 400）。
- 写入：同目录 `.tmp` + `rename` 原子换名，失败清残片并抛错；不产生半截文件。
- 读：坏 JSON 退化到默认值并 warn 一次，不抛错（一个观感插件不该因为配置手滑把页面弄没）。

**为什么不走 `ctx.configForms`**：那套要求宿主导出 Schemastery `Config`、把值写进 profile 的 `cordis.patch.yml`，还要加一条 `@deepseek-ai/schemastery` 依赖。代价是观感开关混进用户的 profile 补丁层，回滚时要动宿主配置。这里改成插件自己的 HTTP 路由：配置始终是插件目录外的一个 JSON 文件，删掉它就回到默认值。

**设置页挂载**（抄 `dsh-tdai-memory-plugin` 的公开接口，不引构建链）：

- `package.json`：`exports["./client"] = "./client.js"`、`dsh.client.platform = "web"`；包已在 profile `bundles` 里，客户端模块系统只认裸包名那一行。
- `client.js`：`window.__ModuleLoader__.load({ id, factory })` 的 lazy-CJS 形状，`require('react')` 拿 React，手写 `createElement`（两个开关不值得引 esbuild）。
- 注册：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-dark-gril-theme', order: 260, label: () => 'Dark Gril 主题' }, Card))`；`inject: ['slots']` 即可。
- 卡片行为：GET 配置 → 渲染两个开关；改动乐观更新 + POST，失败回退旧值并显示原因；POST 成功后调 `__DGT_API__.setMode/setDebug`（第二参 `persist=false`，避免二次落盘）让页面立刻变；监听 `document` 的 `dgt-config` 事件，快捷键改了模式时开关跟着走。
- 文案：`打光模式`（开=beautify 撤遮罩、关=dark 压暗）、`调试浮窗`。

**已验（2026-11-15 15:05–15:12，真机）**

- 宿主侧重启后（profile 没有 `dsh-hmr`，改插件宿主代码只能重启进程）：`GET /dsh-dark-gril-theme/config.json` 200 且含 9 键；`POST {"beautify":true}` 200 并写出 `~/.dsh/dsh-dark-gril-theme.json`；`POST {"nope":1}` 400 `no-valid-key` 且文件不变；`POST {"beautify":false}` 回滚。
- 客户端半边：`__DSH_BOOT__` 图里有 `dsh-dark-gril-theme/client.js&rev=…`；`GET /plugins/??dsh-dark-gril-theme/client.js` 无 rev 404、带 rev 200；改文件后 rev 变（`c20443175767` → `ad292a6e6d5e`），刷新页面即换新。
- 设置页入口（这台机器是 DS Bot 皮肤，左侧没有「设置」按钮）：左下角 **账户** 图标 → 弹层「设置」→ `.bt-settings-layer` 面板；左栏 31 项里「Dark Gril 主题」排在 TDAI Memory 之后，点进去右侧就是本卡片。
- 端到端：点「调试浮窗」→ `aria-checked=true`、`globalThis.__DGT_API__.debug === true`、页面出现 `#dgt-debug`、卡片无「保存失败」；再点回 false，`#dgt-debug` 消失、配置文件复为 `"debug": false`。
- 踩坑记录：`http://127.0.0.1:3082/settings` 是 404（SPA 不做该路径回退），用 bsk 直接 navigate 会把整个会话锁在错误页，只能重启 bsk 会话。设置面板只能从 UI 里点开。

## 已定稿的规格（S2 直接照做）

> 修订 #2 · 2026-11-15 11:45。依据「素材必须完整播完再切」+ 全桶随机轮播改写。修订 #1 中三条作废：①`done` 作为独立态 ②最小驻留 3s ③`tool/call` 作为 acting 边界。旧文见 `git log -p docs/status.md`。

> 修订 #3 · 2026-11-15 12:40。接缝收窄。开右侧边栏时 `videoRight` 落在两栏之间，原 220px 压暗带在深色画面上就是一条可辨的暗带（用户 12:31 截图指出「一道明显的明暗分界」）。改：`SEAM_WIDTH` 220→32、`GLOW_LEAD` 200→32、`#dgt-sheet` 左缘 `inset 1px 0 0` 高光删除、sheet 左移 2px 压住亚像素缝、新增 `clearEdgeBorder()` 按坐标抹掉右栏面板自带的 `border-left`（不猜 CSS Module 类名）。注意它必须用 `elementsFromPoint` 扫：这条边框挂在**兄弟节点**上，交界点本身是个透明的拖拽把手，从交点往祖先走永远找不到它——第一版就是这么漏掉的，肉眼看仍是一根从顶到底的白线。

**状态词表（4 态）**：`idle` / `thinking` / `acting` / `approval`。
`done` 不再是独立态，三段素材并入 idle 池；`speaking` 按修订 #10 退休（素材并入 thinking）；`error` 留接口不启用。

**态 → 轮播桶**（22 段全部投用）

| 态 | 桶内容 | 段数 | 单段时长 s |
| --- | --- | --- | --- |
| idle（新会话） | `idle` | 1 | 6.00 |
| idle（非新会话） | `idle` `done` `done-soft` `done-confirm` | 4 | 6.00 / 6.00 / 6.04 / 6.04 |
| thinking | `thinking` + `speaking` + 11 个 `speaking-*` | 13 | 6.00 / 3.08 / 6.04×11 |
| acting | `acting` `listening` `listening-focus` `listening-nod` | 4 | 3.08 / 6.00 / 6.04 / 6.04 |
| approval | `approval` | 1 | 6.00 |

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
3. `agent/status:running`、`assistant-stream` 开着、工具刚起头 → `thinking`。正文与推理一视同仁，不再按 chunk 类型分叉。
4. 其余 → `idle`。

**acting 插入规则**

- 触发条件：当前会话最近一个已 start、未 end 的 `tools/execute` 连续运行 ≥3s。
- 时机：等当前段播完再插，不打断中途。
- acting 播完：工具仍在跑 → 回上一层桶按不连续重复抽一段；工具已结束 → 按最新态定桶。
- 回到上层后工具仍未结束且新段播完 → 再插 acting，交替直到工具结束。
- 阈值在边界处判定，所以 <3s 的工具永不上屏。实测 p50 0.33s、95% 在 3.08s 内，多数回合看不到 acting——这是设计后果，不是 bug。

**聚合参数**（`agent/assistant-stream` 逐 chunk 发射，未节流，必须自聚合）

- host 侧 16ms 合帧，SSE 推送上限 10Hz。
- 成串阈值（300ms / 8 chunk）已随 `speaking` 退休一并删除：现在只要回合在跑或流开着就是 `thinking`，chunk 只用来触发节拍。
- 交叉淡入 400ms。

**已知取舍**

- done 三档语义消失：不再区分「有审批 / 无工具 / 其余」，四段全随机。
- 12 段 speaking 素材并进 thinking 后纯随机轮播，与内容是推理还是正文无关（原结构判据在并入前就已废弃）。
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

> 修订 #8 · 2026-11-15 15:15。设置页真机验证与深色皮肤对比度修复。
> ① 设置页落位：`settings.section` 注册成功，DS Bot 皮肤的 `.bt-settings-nav` 里出现「Dark Gril 主题」，两个开关渲染、点击落盘、运行时即时生效，全链路通。
> ② 对比度坑：初版提示文字用 `var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))`，实测 computed color 是 `rgba(18, 24, 38, 0.6)` —— DS Bot 皮肤把 `--dsw-alias-label-primary` 定义成 `#121826`（给浅面板的反色）、`--dsw-alias-label-tertiary` 是 `#adb2b8` 一类，**「label-* 就是前景色」这个假设在本皮肤下不成立**，深灰字压在深色面板上几乎看不见。
> ③ 改法：前景一律 `color: inherit` 继承面板自身文字色，副文案用 `opacity: 0.62` 分层次；开关轨道 off `rgba(127,127,127,0.35)`、on `#3b82f6`（对齐皮肤里的 `--dsw-alias-trajectory-accent`）、圆钮 `#ffffff`。不再引用 `--dsw-alias-label-*` 当前景色（仅保留报警文案的 `--dsw-alias-label-warning`）。
> ④ 复验：提示文字 computed color 变 `rgb(232, 237, 247)` / opacity 0.62，截图可读。

> 修订 #9 · 2026-11-15 15:32。调试浮窗重做。用户原话（15:11）：「把 debug 窗口改成可以拖动，然后对文字进行换行分栏，让信息更加清晰。要包含当前监听的是什么状态，下一个预载的视频是什么（如果是轮播的话）等」。
> ① 结构：单个 `<pre>` 换成「标题条 + 两栏网格 + 两张通栏」。卡一到卡三各 4–5 行「标签 → 值」，值 `overflow-wrap: anywhere` 自动换行；卡四把当前桶的每一段渲染成 chip（`▶` 当前、`⏭` 预载目标），卡五是最近 8 条事件流水。
> ② 拖动：只有标题条可拖（`pointerdown` + `setPointerCapture` + 指针捕获失败时退回 `document` 监听），位置写 `sessionStorage['dgt-debug-pos']`（刷新仍在、关浏览器即弃，不污染配置文件）；右上 `−`/`+` 折叠只藏网格、留标题条，折叠状态不存盘。
> ③ 为什么要「在听什么」单独一卡：原先把「快照态」和「正在演」并排放，看不出一段滞后多久。现在把 SSE 源、监听态、快照号与到达时间、会话号与底层态放一起，「到达 2.7s 前」直接说明这条快照停了多久；播放卡里的「元素 video A · rs0」当场暴露解码没起来。
> ④ 起播兜底：`ensurePlaying(reason)` 在 `enable()`、4s 看门狗、`visibilitychange` 回到前台三处触发，最多 3 次；`__DGT_API__.retryPlay()` 手动重试。副标题过滤空字段（没起播时显示「未起播」而不是两个连着的圆点）。
> ⑤ 踩坑：第一版兜底拿 `currentClip !== null` 当哨兵，而 `currentClip` 初值是空串（`var currentClip = ''`）——守卫第一次就早退，日志里连「起播」都不出现。改成独立布尔 `hasStarted`（`commit()` 置真、`disable()` 归假）后才跑通。**教训：用「值不是空」代替「状态已发生」，在初值是空串的变量上必然失灵。**
> ⑥ 真机：拖动（合成 PointerEvent）后 rect 从 [12,196] → [262,76]、`sessionStorage` 记到 `{"left":262,"top":75.5}`；折叠切换 `.is-collapsed` 与 `display:none` 正确；事件流水实时滚动（`15:25:42 监听态 acting → thinking · sse`）。播放卡与预载卡在本窗口恒空——原因是 `document.visibilityState === 'hidden'`，Chrome 推迟媒体加载（见已知限制 3），不是代码问题。

> 修订 #10 · 2026-11-15 15:45。4 态重排。用户原话（15:40）：「现在先把 speaking 相关的素材放入 thinking 状态中，在 agent 输出的时候随机不连续的重播，原来 speaking 监听的宿主信号不再监听。在 acting 的时候，除了 acting 素材，再加上 listening / listening-focus / listening-nod 素材。」
> ① 态表 5 → 4：speaking 整态退休，STATES = [idle, thinking, acting, approval]。text-delta 不再单独成态，「在出正文」与「在推理」都归 thinking。
> ② 桶重排（22 段不增不减）：thinking 1 → 13 段（并入 12 段 speaking）；acting 1 → 4 段（并入 listening 三段）；approval 4 → 1 段（只剩 approval.webm，单段只能重播）。ALL_ASSETS 仍 22，无孤儿片。
> ③ 删掉的代码：STREAK_MS / STREAK_CHUNKS / qualified() / textStreak / reasonStreak。feedChunk 保留（宿主接线不改）但只触发一次重算；isBusy() 改为 approvalPending || running || toolSince >= 0 || streamOpen。成串阈值是为「区分正文/推理」而生的，这个区分本身被取消，阈值就没有存在意义。
> ④ 已知后果：thinking 桶从「单段只能重播」变成 13 段随机轮播，同一态会长短片混播（3.08s 与 6.04s 交替）；approval 从 4 段变单段，等审批时画面固定。acting 的 3s 门槛不变，所以那 4 段仍只在长工具里出现。
> ⑤ 未碰：runtime/bg.js 一行没改——桶映射只有 lib/pools.js 一份真相，页面侧通过 __DGT__.pools 拿。但 lib/* 属宿主侧，必须重启 DSH 才生效。
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

1. **安装方式不是 `dsh plugin add`**：沙箱内那条命令恒报 `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK … Read-only file system`，`dsh web --help` 也会写 `~/.dsh/profiles/web/cordis.yml` 被拒。实际做法是 `pnpm link` 装进 `~/.dsh/profiles/web`（dependencies 里 `"dsh-dark-gril-theme": "link:/mnt/d/workspace/dsh-dark-gril-theme"`，`node_modules/` 下是指向工作区的符号链接，`dsh.profile.bundles` 最后一项也是它）。**改宿主侧代码必须重启 DSH 进程**（profile 没有 `dsh-hmr`，存盘不触发重载）；改 `client.js` 只需刷新页面。
2. **拖窗口尺寸没亲手验过**：`bsk` 的外层窗口 resize 被播放中的视频挡住（`media source changed`），只验了布局变化下的跟随链路。
3. **后台窗口解不出视频帧（已查明，非代码问题）**：Agent Window 默认后台打开时 `document.visibilityState` 为 `hidden`，Chrome 推迟媒体加载，`<video>` 恒停 `readyState 0`、事件只有 `loadstart → stalled`；同一 URL 的 `fetch` 仍是 206/59ms，同页 `curl` 5.4MB/52ms。**bsk 验收必须 `bsk_session start … noFocus:false` 开在前台窗口**，否则会把测试环境当成代码故障。插件侧对此的应对是 `ensurePlaying()` 三处重试 + `__DGT_API__.retryPlay()`，回到前台自动再推一次。
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
| `93582d5` | S3：配置单一真相源（`lib/config.js`）+ 设置页两个开关（`client.js`） |
| `7935e9d` | S3：设置页真机验证通过 + 修深色面板上的文字对比度 |
| `475468c` | 调试浮窗 v2（拖动 / 五栏卡 / 事件流水）+ `hasStarted` 哨兵与起播兜底 |
| `72078cb` | 修订 #10：4 态重排（speaking → thinking，listening → acting），单测同步 |

## 下一步

| 阶段 | 内容 | 预估 | 出口判据 |
| --- | --- | --- | --- |
| ~~S2~~ | ~~host 状态机 + SSE 推状态 + client 桶轮播与 acting 插入~~ **已完成** | 完成 | 假快照下 5 态、整段播完、桶内不重复、acting 交替均已验；真回合端到端见下一行 |
| S2.5 | 真装插件（`dsh plugin --profile web add`）+ 真实回合端到端 | 0.5h | 一次真实回合能在页面上看到 thinking→acting→thinking→idle 的自动切换；`/state` SSE 连上且不断流 |
| ~~S3~~ | ~~设置页开关 + `Ctrl+Alt+B` + 配置文件~~ **已完成** | 完成 | 关掉后无残留、刷新后状态保持 —— 真机点过开关，配置文件与页面运行时双向一致 |
| S3.5 | 调试浮窗 v2（拖动 / 分栏 / 监听态 / 预载可视化） | 完成 | 真机验过拖动、折叠、事件流水；播放与预载卡待用户前台窗口确认 |
| S4 | 脚本化验收（5 态截图 + 右栏取色 + 帧时间 + 残留检测） | 1.5h | 脚本一条命令出报告 |
| S5 | 打磨（光斑与人物过渡、素材缺失兜底文案） | 1h | 用户主观通过 |

## 已拍板（原待定三条，2026-11-15 14:30）

1. **插件名**：`dsh-dark-gril-theme` 为最终名，不改。
2. **素材归属**：22 段已从 `C:\Users\TimKing\Downloads\object-live-states` **移动**进 `assets/`（原目录已清空删除，移动前逐个 sha256 校验与目标一致）。仍由 `.gitignore` 排除，不进 git——仓库只有代码，素材随工作区走。
3. **内部命名**：统一到 `dgt`。全局 `__DGT__`（配置）/ `__DGT_API__`（API）/ `__DGT_INSTALLED__`（幂等哨兵）；元素 `#dgt-stage` `#dgt-glass` `#dgt-sheet` `#dgt-seam` `#dgt-glow` `#dgt-scrim-side` `#dgt-scrim-conv` `#dgt-debug` `#dgt-video-a/b`；类 `.dgt-video`；属性 `html[data-dgt]` / `html[data-dgt-mode]`；CSS 变量 `--dgt-side-dim` `--dgt-conv-dim` `--dgt-glow` `--dgt-sheet-ramp` `--dgt-focus`；localStorage `dgt-mode`；dev server 注入的 style id `dgt-dev-style`。
