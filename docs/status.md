# 进度总结

> 快照：2026-11-15 04:40（Asia/Shanghai）。提交 `d6511fb`，tag `s1-baseline`。

## 一句话状态

**阶段一（基本样式 + 固定视频）视觉已定稿并跑通，状态机未接。** 现在页面里播的是固定 `thinking.webm`，不随 Agent 状态变化。

## 目标与边界

- 目标：DSH Web GUI 的背景视频按 Agent 执行状态切换（idle / thinking / acting / approval / done）。
- 视觉：视频只铺「左侧栏 + 对话区」；第三栏起自建不透明玻璃（竖向渐变 + 一盏跨栏光源），第五、第六栏自动同款。
- 不做：不改 DSH 原生代码、不打补丁到宿主 `node_modules`、不侵入右栏内容区（只画它背后的层）。

## 已完成

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 插件骨架（bundle patch + 注入行 + 路由） | 完成 | `index.js`、`cordis.patch.yml` |
| 素材路由 Range/206 与白名单 | 完成 | `lib/route.js`，`tests/host.test.mjs` 覆盖 200/206/416/HEAD/404 |
| 左中视频铺满（视口原点、列底色/分隔线让位） | 完成 | `runtime/bg.js` `applyLayout()`、`clearColumnBackgrounds()`、`clearColumnBorders()` |
| 尺寸跟随窗口（CSS cover + 三条监听） | 完成 | stage 宽度随布局变化 1943→2583→1943 实测 |
| 右侧玻璃 + 220px 收边 + 跨栏光源 | 完成 | `runtime/bg.css` `#svb-sheet` / `#svb-seam` / `#svb-glow` |
| 深色主题强制与还原 | 完成 | `ensureDark()` / `restoreDark()` |
| 真 DOM 联调（未装插件） | 完成 | 3099 dev server + 页面注入，`readyState 4` |

测试：`node --test tests/host.test.mjs` → 3/3；`node --check index.js runtime/bg.js` 通过。

## 已定稿的规格（S2 直接照做）

**状态词表（5 态）**：`idle` / `thinking` / `acting` / `approval` / `done`。`speaking*`（10 段）与 `error` 留接口不启用；`listening*` 并入 idle 变体池。

**状态源**：会话事件流为主，`sessionStatus` 兜底。白名单 9 事件：`turn/start`、`turn/end`、`step/start`、`step/end`、`tool/call`、`tool/result`、`approval/asked`、`approval/decided`、`agent/error`。

**口径**：最小驻留 3s；`thinking ↔ acting` 只在 `tool/call` 边界互切；done 三档（有 `approval/decided`→`done-confirm`、本回合无 `tool/call`→`done-soft`、其余→`done`），固定 5s 后回落 idle；任意会话 running 即演 working；交叉淡入 400ms，approval 可硬切打断。

**架构**：状态机放 host（`ctx.on` 只在 host 侧可用），client 走 SSE 取状态，SSE 失败降级 1s 轮询。

**开关**：设置页总开关 + `Ctrl+Alt+B`；素材缺失/解码失败自动禁用并回原生外观。

## 关键数字（实测/自算）

- 素材：VP9 2560×1392、24fps、单段 5–6MB、22 段共 127MB。
- 玻璃色阶：`rgb(13,10,12)` → `rgb(47,30,17)`；光源峰 `rgba(226,152,88,·)`。
- scrim：侧栏 0.48 / 对话 0.54；最差对比度 4.69 / 5.52（正文 `#e6e6ec`），对话过 AA。
- 接缝：220px smoothstep，接缝 1px 跳变 0.10–0.12（旧设计 91.2）。
- 整屏铺满需放大 1.5×（1920×1080 级窗口），这是素材分辨率上限，不是排版选择。

## 已知限制

1. **还没真装**：沙箱内 `dsh plugin add` 恒报 `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK … Read-only file system`，`dsh web --help` 也会写 `~/.dsh/profiles/web/cordis.yml` 被拒。目前靠「dev server + 页面注入」验收，真安装要等 S3 且需扩权。
2. **拖窗口尺寸没亲手验过**：`bsk` 的外层窗口 resize 被播放中的视频挡住（`media source changed`），只验了布局变化下的跟随链路。
3. **后台窗口解不出视频帧**：部分 Agent Window 里 `<video>` 恒在 `readyState 0`（同 URL XHR 59ms 拿完 5.4MB），材质核验用静帧替代。
4. **截不到 docked 三/四栏**：本机 dsh-better-sidebar 是浮动模式，网格第三列恒为 0。
5. **内部命名未跟随改名**：全局 `__DSH_STATE_VIDEO_BG__` / `__SVB_INSTALLED__`、元素 id `#svb-*` 仍是旧前缀。

## 下一步

| 阶段 | 内容 | 预估 | 出口判据 |
| --- | --- | --- | --- |
| S2 | host 状态机 + SSE 推状态 + client 双 video 交叉淡入 | 2h | 受控回合能依次出现 5 态，切换无黑帧 |
| S3 | 设置页开关 + `Ctrl+Alt+B` + 配置文件 | 1h | 关掉后无残留、刷新后状态保持 |
| S4 | 脚本化验收（5 态截图 + 右栏取色 + 帧时间 + 残留检测） | 1.5h | 脚本一条命令出报告 |
| S5 | 打磨（光斑与人物过渡、素材缺失兜底文案） | 1h | 用户主观通过 |

## 待用户拍板

1. 仓库/插件名 `dsh-dark-gril-theme` 是否就是最终名（改名涉及 `package.json`、`cordis.patch.yml`、`index.js` 三处 + 路由前缀 + 配置文件名）。
2. `assets/*.webm` 是否入库（现 `.gitignore` 排除，127MB）。
3. 内部全局名是否统一改成 `__DGT_*`。
