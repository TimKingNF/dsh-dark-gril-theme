# dsh-dark-gril-theme

DeepSeek Harness 的暗色主题插件：左栏 + 对话区播放背景视频，右侧工作台自建不透明玻璃（竖向渐变 + 跨栏光源），接缝在视频一侧压暗收边。

当前进度：**阶段一（固定视频 + 主题材质）**视觉定稿，状态机还没接。详见 [docs/status.md](docs/status.md)。

## 结构

| 路径 | 作用 |
| --- | --- |
| `index.js` | 宿主半边：注入 `webserver/index-inject` 两行 + 注册配置/素材路由（Range/206） |
| `cordis.patch.yml` | bundle patch 层，`id`/`name` 必须等于包名 |
| `runtime/bg.css` / `runtime/bg.js` | 页面侧：背景层、玻璃、收边、跨栏光源、布局跟随 |
| `lib/route.js` | Range 解析、MIME、路径白名单 |
| `tests/host.test.mjs` | 宿主契约测试（注入行、200/206/416/HEAD/404、配置默认值） |
| `tools/dev-server.mjs` | 3099 端口静态服务器，供不装插件直接联调 |
| `tools/seam-check.mjs` | 零依赖 PNG 解码，测接缝跳变与光斑单调性 |
| `docs/plan-state-video-bg.md` | 执行计划书（阶段划分、验收、回滚） |
| `docs/status.md` | 进度总结（已完成 / 已定稿规格 / 限制 / 下一步） |

## 跑

```bash
node --test tests/host.test.mjs
node --check runtime/bg.js
```

不装插件联调：`node tools/dev-server.mjs` 起 3099，在任意页面控制台贴一行即可，配置与素材清单由服务器现算：

```js
const s=document.createElement('script');s.src='http://127.0.0.1:3099/inject.js';document.head.appendChild(s)
```

看两种观感（只改两个 CSS 变量，切换瞬时、素材无损）：

```js
__DSH_STATE_VIDEO_BG_API__.toggleMode()   // 或按 Ctrl+Alt+M，选择记在 localStorage['svb-mode']
```

`dark` 压侧栏 0.48 / 对话 0.54 保证文字对比度；`beautify` 全撤，恢复素材原本的肤色打光——代价是对话文字直接压在人物上。

注入后逐态验收（`stateUrl` 为空时只能手动驱动）：

```js
for (const s of ['idle','thinking','speaking','acting','approval']) {
  __DSH_STATE_VIDEO_BG_API__.setState(s); await new Promise(r=>setTimeout(r,7000))
}
```

## 装

```bash
dsh plugin --profile web add "file:$PWD"
```

## 关键约束（改代码前先看）

- 素材透明化覆盖 CSS token（`--dsw-alias-bg-base`、`--dsw-specific-sidebar-fill`），不能挂 class——CSS Modules 会哈希类名。
- 视频层是 `position:fixed`，原点即视口，几何必须从 0 起算，不能拿布局框 `rect.left` 当起点。
- 绝不用注入行的 `kind:'script-src'`，桌面壳上会打掉启动。
- 强制深色主题（`body[data-ds-dark-theme]`）必须在 `disable()` 里还原。
