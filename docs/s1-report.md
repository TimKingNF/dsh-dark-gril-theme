# 阶段一验收：基本样式 + 固定视频播放

状态：**做完，等确认**。按 m00965 的要求停在样式确认这一关，状态机（S2）没动。

## 做了什么

一个独立插件包 `dsh-dark-gril-theme/`（`0.1.0-s1`），走 DSH 的"注入行 + 路由"路线，不带前端构建：

| 文件 | 作用 |
| --- | --- |
| `index.js` | host 半边。`webserver/index-inject` 注册一条 style、一条 script；`webServer.register` 挂 `config.json` 与 `/videos/*`，支持 Range/206；`inject = []`、`apply` 立刻跑 |
| `lib/route.js` | `parseRange` / `contentTypeFor` / `resolveInside` / `toInlineJson` |
| `runtime/bg.css` | 把 `html/body` 与 `--dsw-alias-bg-base`、`--dsw-specific-sidebar-fill` 让开；三层负 z-index：stage(-2) → glass(-1) → 应用内容 |
| `runtime/bg.js` | 找 AppFrame 的 grid、读三列宽度、算视频裁切线、建玻璃与光源、监听 resize/mutation、`Ctrl+Alt+B` 开关 |
| `assets/idle.webm` | 5.46 MB，来自他的 `object-live-states/idle.webm` |
| `tools/dev-server.mjs` | 3099 端口带 CORS 的静态服务器，只为在真 GUI 里注入验收 |
| `tests/host.test.mjs` | 假 Cordis ctx + 真 http server，3 个用例全绿 |

## 三条实现事实

1. **透明化必须走 CSS token，不能挂 class**。DSH 的布局用 CSS Modules，类名是哈希（`pI_x6G_frame`）。样式里覆盖 `--dsw-alias-bg-base` 和 `--dsw-specific-sidebar-fill` 才能让底色让开。
2. **布局要现场量，不能写死**。运行时按"computed `display:grid` + ≥3 列 + 高度 > 55%vh + 宽度 > 50%vw"认框，读 `grid-template-columns` 拿到 `280px / 对话 / 工作台` 三段宽度；工作台关着时第三列是 `0px`，视频自动铺满整窗。
3. **深色主题是视频的前提**。视频底下的区域是暗的，必须挂 `body[data-ds-dark-theme]`，否则浅色正文落在亮画面上看不清。挂之前记住用户原本是不是深色，关掉时还原——否则等于偷偷改了人家的主题。

## 真 GUI 联调结果

在 agent 窗口里打开 `http://127.0.0.1:3080`，把 `bg.css` + `bg.js` 注入真实页面（不装插件，避免动他的 profile）：

```
videoW: 1400px          # 280 侧栏 + 1120 对话
readyState: 4           # 视频已在播
sheet: left:1400px; width:1146px; display:block   # 右侧玻璃正好盖住工作台
```

当时的核对图已随后续宣传图整理移出仓库。接缝核对用的是同一段素材抽出来的静帧，不是 `<video>`——本轮联调窗口里视频解码一直停在 `readyState 0`，连裸 `<video>` 都加载不出来，而同一个 URL 用 XHR 59ms 拿完 5.46MB，是环境问题不是代码问题（上一轮同一份代码在另一个窗口 `readyState: 4` 播过）。材质、遮罩、光源都和播放时同一套 CSS。

开关验证（新标签页、干净 DOM）：关掉后 `data-svb` 摘掉、两层节点残留 0、`--dsw-alias-bg-base` 回到 `#fff`、`data-ds-dark-theme` 还原成 false；再打开能重新建层。

## 第二轮调整（接缝 + 清晰度）

**接缝不再是硬边**。玻璃左缘加 340px 横向 `mask-image` 淡入（stops 0 / .18@18% / .48@40% / .8@68% / #000），并在玻璃上叠一层横向暖雾（`rgba(58,42,34,.55)` → 0 @30%），把左缘亮度提到接近视频那一侧的亮度。视频多画 220px 伸进玻璃底下，让淡入真的化在画面里，而不是化在黑底上。

**光斑收小并向接缝靠**。主光斑 `66% 64% at -2% 106%` → `30% 26% at 8% 104%`，锚点从右区右下角挪到接缝下沿；再加一层 `30% 18% at 4% 101%` 的横向余晖跨过接缝。玻璃元素本身从 `videoRight - 260px` 起算，所以暖光能压到视频那一侧，和人物脚下的光连成同一盏灯。原来那条白色竖向高光去掉（跨过接缝后它变成盖在视频上的一层白雾）。

**清晰度：确实放大过**。之前是 `object-fit: cover` 填满，窗口高 1440 而素材只有 1392 行 → 竖直方向放大 1.034×；DPR 2 的屏上更糟（CSS 1.0 已经是 2 倍物理放大）。现在改成显式摆位：

| 窗口（CSS@DPR） | 处理 | 画面尺寸（CSS） |
| --- | --- | --- |
| 1633×1440@1x | 不放大，底部留 48px 暗带 | 2560×1392 |
| 1633×720@2x | 不放大，留 24px | 1280×696 |
| 1633×1080@2x | 露底 384px 太多 → 填满（1.55×） | 1986×1080 |
| 2400×1300@1x | 本来就需要缩小 | 2400×1305 |

判据：**一个素材像素最多铺一个物理像素**（`scale ≤ 1/dpr`）；只有当"不放大"会导致露底超过 `min(60px, 4%高)` 时才退回填满——一条暗带比整幅糊好认，但大块空白更难看。

## 两个坑，记下来

- `requestAnimationFrame` 在无焦点的后台标签页里会被挂起，布局永远算不出来（第一次联调 `videoW` 是空串）。改 `setTimeout(…, 0)`。
- 重新注入时必须先把旧的 `<script>` 节点删掉再建新的；对已执行过的 script 节点改 `textContent` 再 `appendChild` 不会重跑。

## 没做到的

**真安装没验成**。在沙箱里往临时 `DSH_HOME` 装本包，pnpm 一律报
`ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK ... pnpm-store-operation-locks: Read-only file system (os error 30)`
（真实 store 在 `/home/tim/.local/share/pnpm`，`workspace-write` 下只读；改 `.npmrc store-dir` 和 XDG 目录都没绕过）。`dsh web` 起第二实例也会先写 `/home/tim/.dsh/profiles/web/cordis.yml`，同样 EROFS。

所以阶段一的证据是"同样的代码在真 DOM 里跑通 + host 半边离线测试"，不是"插件被 loader 装起来"。真安装放在 S3，那一步需要放宽沙箱或直接装进他自己的 profile——到时候我会先问。

## 下一步（S2，未开始）

按 m00843：状态事件照抄 `dsh-live2d-pets`（`agent/status`、`agent/error`、`turn-stopping`、`approval/request`、`session/event`），5 态 + idle 变体池，最小驻留 3s，`done` 保持 5s 后回落。
