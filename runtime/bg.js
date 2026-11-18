/*
 * dsh-dark-gril-theme —— 页面侧运行时（阶段一：固定视频 + 材质）。
 *
 * 阶段一不做状态机：素材固定播 idle，先把"视频在前两栏、右栏自建不透明玻璃"这套
 * 材质定下来。状态切换在 S2 由宿主推 SSE，这里只留一个 state 变量和 setState 入口。
 *
 * 右区几何只认一个数：videoRight（侧栏+对话区的右缘）。右区被分成 3/4/5/6 栏
 * 对这里没有区别——玻璃、接缝收边、光源都是"从某个 x 到窗口右缘"的一整块。
 *
 * 几何来源：AppFrame 是 CSS grid（侧栏 / 对话 / 工作台三列），列宽写在
 * `grid-template-columns` 上。这里不去记 class 名（CSS Modules 会哈希），
 * 而是按"display:grid + ≥3 列 + 占满视口"认出那个框，读它的列宽。
 */
;(function () {
  'use strict'

  if (globalThis.__DGT_INSTALLED__) return
  globalThis.__DGT_INSTALLED__ = true

  var CONFIG = globalThis.__DGT__
  if (!CONFIG || typeof CONFIG !== 'object') CONFIG = {}

  var HTML_ATTR = 'data-dgt'
  /** 接缝收边带宽度：只做 32px 的软接边。再宽（原 220px）就成了画面里一条可辨的暗带。 */
  var SEAM_WIDTH = 32
  /** 光源左缘与收边带对齐：灯停在右区里，不越过接缝探进视频。 */
  var GLOW_LEAD = 32
  var body = null
  var host = null
  var frame = null
  /** 双 video 交叉淡入：每次换的是另一个元素，currentTime 永远不 seek。 */
  var videos = []
  var videoIndex = 0
  /** 当前在播的元素，布局与卸载代码沿用这个名字。 */
  var video = null
  /** 当前在播的素材名、它所属的桶、它在桶里的下标（不连续重复要用）。 */
  var currentClip = ''
  // currentClip 的初值是空串，不能当哨兵：'还没有画面' 和 '播过至少一段' 要分开记。
  var hasStarted = false
  var currentPool = null
  var currentIndex = -1
  /** 当前这一段是替哪个态播的（acting 与底层态交替时要用）。 */
  var currentChosenState = ''
  /** acting 下面那一层：acting 播完先回它，再考虑下一段 acting。 */
  var underlyingState = 'idle'
  /** 最近一次收到的状态快照；边界那一刻以它为准，不做队列。 */
  var latestSnapshot = null
  /** 宿主注入的素材桶。 */
  var pools = {}
  var stateSource = null
  // 两种观感：dark 是默认的可读版（压 0.48/0.54 的暗蒙版）；
  // beautify 把蒙版全撤，恢复素材原本的肤色与打光。切换只改变量，不动结构。
  var DIM_MODES = {
    // glow 跟 conv 反着走，但压得比「1-conv」更狠：对话区压 0.54 时
    // 光斑只留 0.25。线性按 0.46 留，肉眼看还是比画面亮一截，因为
    // 暖光压在近黑底上，sRGB 编码会把差异放大；0.25 才读得出来是同一层暗。
    dark: { side: 0.48, conv: 0.54, glow: 0.25 },
    beautify: { side: 0, conv: 0, glow: 1 },
  }
  /** 右区玻璃的竖向色阶在 CSS 里，启动时拷一份原值，好让 beautify 能换回去。 */
  var BASE_RAMP = ''
  /**
   * dark 模式专用的更暗色阶：只把 83% 与 100% 两档压下来（32,21,14 → 26,17,12、
   * 47,30,17 → 37,23,14），中上部原样。
   *
   * 为什么动这个而不是只动 --dgt-glow：实测面板左下角那块，0.46 → 0.10 才降
   * 5.5 级（41.0 → 35.5），因为那块亮度里八成来自玻璃自身底色的暖色，
   * 光斑只占小头。要让 dark 真的暗一档，只能压这两个色阶。
   */
  var DARK_RAMP =
    'linear-gradient(180deg, rgb(13,10,12) 0%, rgb(14,11,11) 40%, rgb(19,14,11) 64%, rgb(26,17,12) 83%, rgb(37,23,14) 100%)'
  // 模式与调试开关只存一份：$DSH_HOME 下的配置文件。页面这边不再写 localStorage，
  // 否则「设置卡片改了」和「上一次按快捷键留下的值」会互相覆盖。
  var mode = 'dark'
  var pollTimer = null
  var sseErrors = 0
  /** 每次换片自增，用来丢弃迟到的 canplay 回调。 */
  var boundaryToken = 0
  var boundaryWatch = 0
  var advancing = false
  /**
   * 边界提前量：还差这么多毫秒就把下一段换上来，绝不等到 `ended`。
   *
   * 等到 `ended` 才换有个空档：元素播完后它呈现的那一帧可能已经失效，而新元素的首帧
   * 还没提交给合成器——中间露出来的是深色舞台底，就是那几帧黑。提前 450ms（淡出 400ms
   * + 50ms 余量）换，旧元素在整个淡出过程里都还在正常出画，永远不会走到"播完"那一刻。
   */
  var BOUNDARY_LEAD_MS = 450
  /**
   * 换片过渡。两种：
   *
   * - `dip`（默认）盖住再揭：先压一段暗，盖满的那一刻换元素，再揭开。
   *   直接交叉淡入的问题是素材本身——每段里人物的位置和姿态不一样，两层同时半透明时
   *   会读出两个影子，看着就是「跳了一下」。盖住的这 150ms 里换的是元素，眼睛只看到
   *   一次均匀的明暗起伏，读成呼吸。
   * - `cross` 两段直接叠着淡，留着做对照。
   *
   * 暗色取玻璃色阶最暗的一档 rgb(13,10,12)，不是纯黑：纯黑贴在浅色面板边上太跳。
   */
  var DIP_IN_MS = 150
  var DIP_OUT_MS = 220
  var TRANSITION_KEY = 'dgt-transition'
  var transition = 'dip'
  /** 过暗一闪的遮盖层，几何跟随 stage（inset:0），不需要单独摆位。 */
  var dipEl = null
  /** 预加载的那一手：边界时刻如果还是这个态，直接用它，不再重新抽。 */
  var warmPlan = null
  /** 调试浮窗；只有 CONFIG.debug 为真才建。 */
  var debugEl = null
  var debugTimer = null
  /** 调试窗里的值节点、桶列表、事件流水，按引用更新，避免每 250ms 重建 DOM。 */
  var debugFields = {}
  var debugPoolEl = null
  var debugLogEl = null
  var debugLog = []
  /** 最近一次收到快照的时刻，用来显示「这条状态多新」。 */
  var lastSnapshotAt = 0
  /** 状态来自哪：sse / poll / manual，排障时要看这个。 */
  var sourceKind = 'manual'
  var scrimSide = null
  var scrimConv = null
  var sheet = null
  var seam = null
  var glow = null
  var enabled = CONFIG.enabled !== false
  var state = 'idle'
  var resizeObserver = null
  var mutationObserver = null
  var rafPending = false

  function warn(message) {
    console.warn('[dsh-dark-gril-theme] ' + message)
  }

  /** 认布局框：display:grid、至少三列、几乎占满视口。 */
  function findFrame() {
    if (frame && frame.isConnected) return frame
    var root = document.getElementById('root') || body
    var all = root.querySelectorAll('*')
    for (var i = 0; i < all.length; i += 1) {
      var el = all[i]
      var cs = getComputedStyle(el)
      if (cs.display !== 'grid') continue
      var tracks = cs.gridTemplateColumns
      if (!tracks || tracks.split(' ').length < 3) continue
      var rect = el.getBoundingClientRect()
      if (rect.height < innerHeight * 0.55) continue
      if (rect.width < innerWidth * 0.5) continue
      frame = el
      return frame
    }
    return null
  }

  /** 从 grid-template-columns 里读出前两列像素宽。 */
  function readTracks(el) {
    var cs = getComputedStyle(el)
    var parts = cs.gridTemplateColumns.split(' ').filter(function (p) {
      return p !== ''
    })
    var nums = parts.map(function (p) {
      var value = parseFloat(p)
      return Number.isFinite(value) ? value : 0
    })
    return nums
  }

  // ── 素材桶与轮播 ────────────────────────────────────────────

  /** 按"素材真实存在"过滤宿主注入的桶；缺段摘掉，整桶摘空就回落。 */
  function normalizePools() {
    var source = CONFIG.pools && typeof CONFIG.pools === 'object' ? CONFIG.pools : {}
    var have =
      Object.prototype.toString.call(CONFIG.available) === '[object Array]'
        ? new Set(CONFIG.available)
        : null
    var out = {}
    Object.keys(source).forEach(function (key) {
      var list = source[key]
      if (Object.prototype.toString.call(list) !== '[object Array]') return
      out[key] = list.filter(function (name) {
        return have === null || have.has(name)
      })
    })
    return out
  }

  // 轮播规则由宿主注入（唯一实现在 lib/pools.js），页面不再抄一份。
  var RULES = globalThis.__DGT_RULES__ || {}

  /** 桶内抽下一段；注入缺失时退化成纯随机，不会连续重复的保证丢了，但画面不会停。 */
  function pickIndex(pool, last) {
    if (typeof RULES.pickNext === 'function') return RULES.pickNext(pool, last)
    return pool.length ? Math.floor(Math.random() * pool.length) : 0
  }

  /**
   * 取某个态该用的桶。桶名由宿主算好放进快照（current.pool），
   * 页面只查表与回落，不再复刻 lib/pools.js 里 idleNew 的收窄规则。
   */
  function poolForState(name) {
    var snap = latestSnapshot
    var key = snap && snap.current && typeof snap.current.pool === 'string' ? snap.current.pool : name
    var list = pools[key] || []
    if (list.length) return list
    // 该态没有素材：回落到 idle 宽桶，画面不至于停住
    if (pools.idle && pools.idle.length) return pools.idle
    return pools.idleNew || []
  }

  function videoUrlFor(name) {
    var prefix = typeof CONFIG.videoPrefix === 'string' ? CONFIG.videoPrefix : ''
    return prefix + encodeURIComponent(name)
  }

  /** 只看快照得出"该演哪个态"，不做随机抽取，可以在边界前重复调用。 */
  function planState() {
    var snap = latestSnapshot
    var target =
      snap && snap.current && typeof snap.current.state === 'string' ? snap.current.state : 'idle'
    // acting 与它下面那一层交替：上一段已经是 acting，就先回底层一段。
    if (target === 'acting' && currentChosenState === 'acting' && underlyingState !== 'acting') {
      return underlyingState
    }
    return target
  }

  /** 边界时刻读最新快照，决定下一段播什么（会抽一次随机）。 */
  function decideNext() {
    var target = planState()
    var pool = poolForState(target)
    if (!pool.length) return null
    var last = pool === currentPool ? currentIndex : -1
    var idx = pickIndex(pool, last)
    return { state: target, pool: pool, index: idx, clip: pool[idx] }
  }

  /** 把下一段先装进另一个 video 元素，但不播。 */
  function warmNextClip() {
    if (videos.length < 2) return
    var target = planState()
    if (warmPlan && warmPlan.state === target) return
    var plan = decideNext()
    if (!plan) return
    var el = videos[(videoIndex + 1) % videos.length]
    warmPlan = plan
    logDebug('预载 ' + plan.clip + ' · ' + plan.state + ' #' + plan.index + '/' + plan.pool.length)
    if (el.dataset.clip === plan.clip && el.readyState >= 2) return
    el.dataset.clip = plan.clip
    el.src = videoUrlFor(plan.clip)
    try {
      el.load()
    } catch (error) {
      /* 忽略 */
    }
  }

  /**
   * 盯当前元素的剩余时长，到提前量就换片。
   *
   * 用 requestAnimationFrame 而不是 timeupdate：后者只有 ~4Hz，450ms 的窗口最多踩一次，
   * 页面卡一下就会落到 `ended` 之后（正是要避免的那个空档）。可见性为 hidden 时 rAF 停摆，
   * 那一刻的视觉也无所谓，`ended` 仍然兜底。
   */
  function watchBoundary() {
    if (boundaryWatch || !enabled) return
    boundaryWatch = requestAnimationFrame(function step() {
      boundaryWatch = 0
      if (!enabled || !video) return
      var el = video
      var total = el.duration
      if (!advancing && isFinite(total) && total > 0 && !el.paused) {
        var remainMs = (total - el.currentTime) * 1000
        if (remainMs <= BOUNDARY_LEAD_MS) {
          logDebug('边界 · 剩余 ' + Math.round(remainMs) + 'ms')
          advance()
          return
        }
      }
      boundaryWatch = requestAnimationFrame(step)
    })
  }

  /** 边界动作：抽下一段并换上去。重复触发由 advancing 挡住。 */
  function advance() {
    if (advancing) return
    advancing = true
    var plan = takeNext()
    if (!plan) {
      advancing = false
      return
    }
    playClip(plan)
  }

  /** 边界时取下一段：预载用得上就用预载，态变了就现抽。 */
  function takeNext() {
    var target = planState()
    var plan = warmPlan && warmPlan.state === target ? warmPlan : decideNext()
    warmPlan = null
    return plan
  }

  function makeVideoElement(id) {
    var el = document.createElement('video')
    el.id = id
    el.className = 'dgt-video'
    el.muted = true
    el.defaultMuted = true
    el.playsInline = true
    el.preload = 'auto'
    // 不设 loop：轮播要靠 ended 这个边界事件，loop 永远不给。
    el.setAttribute('muted', '')
    el.setAttribute('playsinline', '')
    el.setAttribute('aria-hidden', 'true')
    el.addEventListener('loadedmetadata', function () {
      schedule()
    })
    el.addEventListener('timeupdate', function () {
      if (el !== video) return
      var total = el.duration
      if (!isFinite(total) || total <= 0) return
      // 提前预载下一段：到边界时元素已经 readyState>=2，换片就不用等解码。
      // 1.2s 留量：本机 canplay 约 0.2s，慢盘/慢网约 0.6–1.0s。
      if (total - el.currentTime <= 1.2) warmNextClip()
    })
    // 兜底：正常情况下 450ms 的提前量已经换过片了，走到这里说明 rAF 停过（后台/掉帧）
    el.addEventListener('ended', function () {
      if (el !== video || advancing) return
      logDebug('边界兜底 · ended')
      advance()
    })
    el.addEventListener('error', function () {
      warn('素材加载失败：' + String(el.dataset.clip || el.src))
    })
    return el
  }

  /**
   * 首帧门闩：回调触发时说明这一帧已经交给合成器，可以安全地把旧元素淡出去了。
   *
   * canplay / loadeddata / playing 只保证「数据够了」，不保证「屏幕上已经有画面」——
   * 换片时那几帧黑就是在这儿漏出来的。requestVideoFrameCallback 是唯一对准的时机：
   * 它在帧被提交给合成器时回调。
   *
   * rVFC 迟迟不来（后台标签页、解码卡住、play() 被拒）时 400ms 兜底放行，
   * 最坏退化成「不等首帧」的旧行为，不会把播放卡死。
   */
  function firstFrame(el, cb) {
    var fired = false
    function once() {
      if (fired) return
      fired = true
      cb()
    }
    if (typeof el.requestVideoFrameCallback === 'function') {
      el.requestVideoFrameCallback(function () {
        requestAnimationFrame(once)
      })
      setTimeout(once, 400)
      return
    }
    // 老 Chrome 没有 rVFC：canplay 之后再等一小段，让首帧有机会提交
    setTimeout(once, 60)
  }

  /**
   * 播一段：换到另一个 video 元素，等新元素真的出画了才把旧元素淡出去。
   *
   * 叠放口径见 bg.css：新元素先以「不透明但在下」的形态垫好，旧元素仍带 data-top 盖在上面，
   * 所以新元素的空帧永远露不出来；等首帧呈现后才给旧元素打 data-hide 淡出。
   */
  /** 换片时唯一记账的地方：两条过渡路径都走它，省得两边状态漂移。 */
  function adoptClip(decision, nextIndex, incoming) {
    videoIndex = nextIndex
    video = incoming
    currentClip = decision.clip
    currentPool = decision.pool
    currentIndex = decision.index
    currentChosenState = decision.state
    if (decision.state !== 'acting') underlyingState = decision.state
    state = decision.state
    startAttempts = 0
    hasStarted = true
    advancing = false
    watchBoundary()
    logDebug('播 ' + decision.clip + ' · ' + decision.state + ' #' + decision.index + '/' + decision.pool.length)
    schedule()
  }

  /** 瞬时摆上屏：不给过渡，"归位"本身就不会变成一次闪。 */
  function snapIn(el) {
    el.setAttribute('data-instant', '')
    el.removeAttribute('data-hide')
    el.setAttribute('data-top', '')
    void el.offsetWidth
    el.removeAttribute('data-instant')
  }

  /** 瞬时关掉旧元素，并且一定把它停住（别再往后播）。 */
  function snapOut(el) {
    el.setAttribute('data-instant', '')
    el.setAttribute('data-hide', '')
    el.removeAttribute('data-top')
    void el.offsetWidth
    el.removeAttribute('data-instant')
    try {
      el.pause()
    } catch (error) {
      /* 暂停失败不影响换片 */
    }
  }

  function playClip(decision, opts) {
    if (!decision || videos.length === 0) return
    var fadeMs = opts && isFinite(opts.fadeMs) ? opts.fadeMs : 400
    var token = (boundaryToken += 1)
    var nextIndex = (videoIndex + 1) % videos.length
    var incoming = videos[nextIndex]
    var outgoing = videos[videoIndex]
    var firstRun = !hasStarted || !outgoing || outgoing === incoming
    // 首次起播没有旧元素可盖，硬切本来就是对的，不走 over-dark
    var useDip = !firstRun && transition === 'dip' && !!dipEl

    function commit() {
      if (token !== boundaryToken) return

      if (useDip) {
        // 盖 → 换 → 揭。覆盖期间画面上什么都没有，新元素的空帧与旧元素的残帧都看不见。
        var inMs = Math.round((opts && opts.dipInMs) || DIP_IN_MS)
        var outMs = Math.round((opts && opts.dipOutMs) || DIP_OUT_MS)
        if (inMs <= 0) {
          try {
            incoming.currentTime = 0
          } catch (error) {
            /* 元数据没就绪时忽略 */
          }
          snapIn(incoming)
          var hardPlay = incoming.play()
          if (hardPlay && typeof hardPlay.catch === 'function') {
            hardPlay.catch(function (error) {
              warn('素材未能自动播放：' + String(error))
            })
          }
          snapOut(outgoing)
          adoptClip(decision, nextIndex, incoming)
          return
        }
        dipEl.style.transition = 'opacity ' + inMs + 'ms linear'
        dipEl.style.opacity = '1'
        logDebug('过暗 · 盖 ' + inMs + 'ms → 换片 → 揭 ' + outMs + 'ms')
        setTimeout(function () {
          if (token !== boundaryToken) return
          try {
            incoming.currentTime = 0
          } catch (error) {
            /* 元数据没就绪时忽略 */
          }
          snapIn(incoming)
          var played = incoming.play()
          if (played && typeof played.catch === 'function') {
            played.catch(function (error) {
              warn('素材未能自动播放：' + String(error))
            })
          }
          snapOut(outgoing)
          adoptClip(decision, nextIndex, incoming)
          dipEl.style.transition = 'opacity ' + outMs + 'ms linear'
          dipEl.style.opacity = '0'
        }, inMs)
        return
      }

      // 预备：这一步只是把新元素摆成正确的叠放与可见性，不该有任何动画
      incoming.setAttribute('data-instant', '')
      if (firstRun) {
        incoming.setAttribute('data-hide', '')
        incoming.setAttribute('data-top', '')
      } else {
        incoming.removeAttribute('data-hide')
        incoming.removeAttribute('data-top')
      }
      try {
        incoming.currentTime = 0
      } catch (error) {
        /* 元数据没就绪时忽略，反正它就是 0 */
      }
      void incoming.offsetWidth
      incoming.removeAttribute('data-instant')

      var played = incoming.play()
      if (played && typeof played.catch === 'function') {
        played.catch(function (error) {
          warn('素材未能自动播放：' + String(error))
        })
      }

      // 记账放在同步段：调试浮窗与状态机不该等首帧
      adoptClip(decision, nextIndex, incoming)

      if (firstRun) {
        // 首次起播没有旧元素可淡出：等首帧到了再点亮，开局也不留一块黑
        firstFrame(incoming, function () {
          if (token !== boundaryToken) return
          incoming.setAttribute('data-instant', '')
          incoming.removeAttribute('data-hide')
          incoming.setAttribute('data-top', '')
          void incoming.offsetWidth
          incoming.removeAttribute('data-instant')
        })
        return
      }

      firstFrame(incoming, function () {
        if (token !== boundaryToken) return
        logDebug('首帧 ✓ ' + decision.clip + ' · 淡出 ' + fadeMs + 'ms')
        outgoing.setAttribute('data-hide', '')
        setTimeout(function () {
          // 淡完时旧元素还差多少到结尾：>0 说明全程没走到 ended，那个空档就不存在
          var tail = outgoing.duration - outgoing.currentTime
          logDebug('淡出完成 · 旧元素余 ' + (isFinite(tail) ? Math.round(tail * 1000) + 'ms' : '—'))
          // 停旧元素与 token 无关：过期只代表这次淡出被下一次换片接管了，元素还是要停
          try {
            outgoing.pause()
          } catch (error) {
            /* 忽略 */
          }
          if (token !== boundaryToken) return
          outgoing.removeAttribute('data-top')
          incoming.setAttribute('data-top', '')
        }, fadeMs + 20)
      })
    }

    if (incoming.dataset.clip === decision.clip && incoming.readyState >= 2) {
      commit()
      return
    }
    incoming.dataset.clip = decision.clip
    incoming.addEventListener('canplay', commit, { once: true })
    incoming.src = videoUrlFor(decision.clip)
    try {
      incoming.load()
    } catch (error) {
      /* 忽略 */
    }
  }

  /** approval 要硬切：等人时不该还在演上一段。 */
  function maybeHardCut() {
    var snap = latestSnapshot
    if (!snap || !snap.current) return
    if (snap.current.state !== 'approval') return
    if (currentChosenState === 'approval') return
    var plan = decideNext()
    if (plan && plan.state === 'approval') playClip(plan, { fadeMs: 120 })
    else playClip(plan)
  }

  function applySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return
    var prev = latestSnapshot && latestSnapshot.current ? latestSnapshot.current.state : null
    latestSnapshot = snap
    lastSnapshotAt = Date.now()
    var name = snap.current && typeof snap.current.state === 'string' ? snap.current.state : 'idle'
    state = name
    if (prev !== name) {
      logDebug('监听态 ' + (prev === null ? '→ ' : prev + ' → ') + name + ' · ' + sourceKind)
    }
    maybeHardCut()
  }

  /** 状态源：SSE 优先，连续失败 3 次降级成 1s 轮询。 */
  function startStateStream() {
    var url = typeof CONFIG.stateUrl === 'string' ? CONFIG.stateUrl : ''
    if (url === '' || typeof EventSource === 'undefined') {
      startPolling()
      return
    }
    try {
      stateSource = new EventSource(url)
      sourceKind = 'sse'
    } catch (error) {
      warn('状态推送不可用，改用轮询：' + String(error))
      startPolling()
      return
    }
    stateSource.onmessage = function (event) {
      sseErrors = 0
      try {
        applySnapshot(JSON.parse(event.data))
      } catch (error) {
        warn('状态消息解析失败：' + String(error))
      }
    }
    stateSource.onerror = function () {
      sseErrors += 1
      if (sseErrors < 3) return
      warn('状态推送连续失败，改用轮询')
      stopStateStream()
      startPolling()
    }
  }

  function startPolling() {
    if (pollTimer !== null) return
    sourceKind = 'poll'
    var url = typeof CONFIG.stateJsonUrl === 'string' ? CONFIG.stateJsonUrl : ''
    if (url === '') return
    function pull() {
      fetch(url, { cache: 'no-store' })
        .then(function (res) {
          return res.json()
        })
        .then(applySnapshot)
        .catch(function (error) {
          warn('状态轮询失败：' + String(error))
        })
    }
    pull()
    pollTimer = setInterval(pull, 1000)
  }

  function stopStateStream() {
    if (stateSource) {
      try {
        stateSource.close()
      } catch (error) {
        /* 忽略 */
      }
      stateSource = null
    }
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  // ── 调试浮窗 ────────────────────────────────────────

  var DEBUG_POS_KEY = 'dgt-debug-pos'
  var startAttempts = 0

  function debugClock(at) {
    var d = new Date(at)
    function pad(n) {
      return n < 10 ? '0' + n : String(n)
    }
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  }

  /** 事件流水：只在调试窗开着时记，关掉就清空，不占常驻内存。 */
  function logDebug(text) {
    if (!debugEl) return
    debugLog.push({ at: Date.now(), text: text })
    if (debugLog.length > 8) debugLog.shift()
    renderDebugLog()
  }

  function renderDebugLog() {
    if (!debugLogEl) return
    debugLogEl.textContent = ''
    if (debugLog.length === 0) {
      var empty = document.createElement('li')
      empty.className = 'is-empty'
      empty.textContent = '（还没有状态变化）'
      debugLogEl.appendChild(empty)
      return
    }
    for (var i = debugLog.length - 1; i >= 0; i -= 1) {
      var li = document.createElement('li')
      var t = document.createElement('span')
      t.className = 'dgt-debug-t'
      t.textContent = debugClock(debugLog[i].at)
      var m = document.createElement('span')
      m.textContent = debugLog[i].text
      li.appendChild(t)
      li.appendChild(m)
      debugLogEl.appendChild(li)
    }
  }

  function debugSet(key, value) {
    var el = debugFields[key]
    if (el && el.textContent !== value) el.textContent = value
  }

  /** 一张卡片：标题 + 若干「标签 / 值」行；值的节点记进 debugFields 供后续按引用更新。 */
  function debugCard(title, rows, wide) {
    var card = document.createElement('section')
    card.className = 'dgt-debug-card' + (wide ? ' is-wide' : '')
    var h = document.createElement('h3')
    h.textContent = title
    card.appendChild(h)
    for (var i = 0; i < rows.length; i += 1) {
      var row = document.createElement('div')
      row.className = 'dgt-debug-row'
      var k = document.createElement('span')
      k.className = 'dgt-debug-k'
      k.textContent = rows[i][0]
      var v = document.createElement('span')
      v.className = 'dgt-debug-v'
      row.appendChild(k)
      row.appendChild(v)
      card.appendChild(row)
      debugFields[rows[i][1]] = v
    }
    return card
  }

  function clampDebugPos(left, top) {
    var w = debugEl.offsetWidth || 460
    var h = debugEl.offsetHeight || 200
    return {
      left: Math.min(Math.max(0, left), Math.max(0, window.innerWidth - w)),
      top: Math.min(Math.max(0, top), Math.max(0, window.innerHeight - h)),
    }
  }

  function applyDebugPos(left, top) {
    var pos = clampDebugPos(left, top)
    debugEl.style.left = pos.left + 'px'
    debugEl.style.top = pos.top + 'px'
    debugEl.style.bottom = 'auto'
    debugEl.style.right = 'auto'
  }

  function saveDebugPos() {
    try {
      sessionStorage.setItem(
        DEBUG_POS_KEY,
        JSON.stringify({
          left: parseFloat(debugEl.style.left) || 0,
          top: parseFloat(debugEl.style.top) || 0,
        }),
      )
    } catch (error) {
      /* 无痕模式等场景写不进去，位置就只在本页有效 */
    }
  }

  /**
   * 标题条拖动。位置只存 sessionStorage：它是查看时的临时摆放，不是配置，
   * 不进 $DSH_HOME 那份唯一真相源，重开标签页即回到左下角默认位。
   */
  function makeDebugDraggable(head) {
    try {
      var saved = JSON.parse(sessionStorage.getItem(DEBUG_POS_KEY) || 'null')
      if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
        applyDebugPos(saved.left, saved.top)
      }
    } catch (error) {
      /* 坏值当没存过 */
    }

    head.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return
      if (event.target && event.target.tagName === 'BUTTON') return
      event.preventDefault()
      var rect = debugEl.getBoundingClientRect()
      var dx = event.clientX - rect.left
      var dy = event.clientY - rect.top
      applyDebugPos(rect.left, rect.top)
      try {
        head.setPointerCapture(event.pointerId)
      } catch (error) {
        /* 忽略 */
      }
      function move(ev) {
        applyDebugPos(ev.clientX - dx, ev.clientY - dy)
      }
      function up(ev) {
        head.removeEventListener('pointermove', move)
        head.removeEventListener('pointerup', up)
        head.removeEventListener('pointercancel', up)
        try {
          head.releasePointerCapture(ev.pointerId)
        } catch (error) {
          /* 忽略 */
        }
        saveDebugPos()
      }
      head.addEventListener('pointermove', move)
      head.addEventListener('pointerup', up)
      head.addEventListener('pointercancel', up)
    })

    // 窗口缩小后别把窗留在屏幕外。
    window.addEventListener('resize', function () {
      if (!debugEl || debugEl.style.top === '') return
      applyDebugPos(parseFloat(debugEl.style.left) || 0, parseFloat(debugEl.style.top) || 0)
    })
  }

  function startDebug() {
    if (debugEl) return
    debugEl = document.createElement('div')
    debugEl.id = 'dgt-debug'

    var head = document.createElement('div')
    head.className = 'dgt-debug-head'
    var title = document.createElement('span')
    title.className = 'dgt-debug-title'
    title.textContent = 'DGT 调试'
    var sub = document.createElement('span')
    sub.className = 'dgt-debug-sub'
    sub.id = 'dgt-debug-sub'
    var fold = document.createElement('button')
    fold.type = 'button'
    fold.className = 'dgt-debug-fold'
    fold.title = '折叠 / 展开'
    fold.textContent = '−'
    fold.addEventListener('click', function () {
      var folded = debugEl.classList.toggle('is-collapsed')
      fold.textContent = folded ? '+' : '−'
    })
    head.appendChild(title)
    head.appendChild(sub)
    head.appendChild(fold)
    debugEl.appendChild(head)

    var grid = document.createElement('div')
    grid.className = 'dgt-debug-grid'
    grid.appendChild(
      debugCard('状态源 · 在听什么', [
        ['源', 'source'],
        ['监听态', 'listen'],
        ['快照', 'snapshot'],
        ['到达', 'age'],
        ['会话', 'session'],
      ]),
    )
    grid.appendChild(
      debugCard('播放 · 在演什么', [
        ['态', 'playing'],
        ['素材', 'clip'],
        ['进度', 'progress'],
        ['元素', 'slot'],
        ['剩余', 'remain'],
      ]),
    )
    grid.appendChild(
      debugCard('预载 · 下一段', [
        ['素材', 'warm'],
        ['对应态', 'warmState'],
        ['桶序', 'warmIndex'],
        ['就绪', 'warmReady'],
        ['边界策略', 'boundary'],
      ]),
    )
    var poolCard = debugCard('当前轮播桶', [], true)
    debugPoolEl = document.createElement('div')
    debugPoolEl.className = 'dgt-debug-chips'
    poolCard.appendChild(debugPoolEl)
    grid.appendChild(poolCard)
    var logCard = debugCard('最近变化', [], true)
    debugLogEl = document.createElement('ol')
    debugLogEl.className = 'dgt-debug-log'
    logCard.appendChild(debugLogEl)
    grid.appendChild(logCard)
    debugEl.appendChild(grid)

    document.body.appendChild(debugEl)
    makeDebugDraggable(head)
    renderDebugLog()
    debugTimer = setInterval(renderDebug, 250)
    renderDebug()
  }

  function stopDebug() {
    if (debugTimer !== null) {
      clearInterval(debugTimer)
      debugTimer = null
    }
    if (debugEl) {
      debugEl.remove()
      debugEl = null
    }
    debugFields = {}
    debugPoolEl = null
    debugLogEl = null
    debugLog = []
  }

  function renderDebug() {
    if (!debugEl) return
    var el = video
    var total = el && isFinite(el.duration) ? el.duration : 0
    var at = el ? el.currentTime : 0
    var snap = latestSnapshot
    var cur = snap && snap.current ? snap.current : null
    var seq = snap && typeof snap.seq === 'number' ? snap.seq : '-'
    var agents = snap && snap.agents ? snap.agents.length : 0
    var age = lastSnapshotAt ? (Date.now() - lastSnapshotAt) / 1000 : null

    debugSet(
      'source',
      sourceKind === 'sse'
        ? 'SSE' + (sseErrors ? '（重连 ' + sseErrors + '）' : ' · 在线')
        : sourceKind === 'poll'
          ? '轮询 1s'
          : '手动 setState',
    )
    debugSet('listen', cur ? cur.state + (cur.isNew ? ' · 新会话' : '') : '—')
    debugSet('snapshot', '#' + seq + (snap && snap.time ? ' · ' + debugClock(snap.time) : ''))
    debugSet('age', age === null ? '—' : (age < 10 ? age.toFixed(1) : String(Math.round(age))) + 's 前')
    debugSet('session', '会话 ' + agents + ' · 底层 ' + underlyingState)

    debugSet('playing', currentChosenState || '—')
    debugSet('clip', currentClip || '—')
    debugSet(
      'progress',
      total > 0
        ? at.toFixed(2) + ' / ' + total.toFixed(2) + ' · ' + Math.round((at / total) * 100) + '%'
        : at.toFixed(2) + ' / —',
    )
    debugSet('slot', 'video ' + (videoIndex === 0 ? 'A' : 'B') + (el && el.readyState < 3 ? ' · rs' + el.readyState : ''))
    debugSet('remain', total > 0 ? Math.max(0, total - at).toFixed(2) + 's' : '—')

    var warm = warmPlan
    var warmEl = videos.length > 1 ? videos[(videoIndex + 1) % videos.length] : null
    debugSet('warm', warm ? warm.clip : '（还没预载）')
    debugSet('warmState', warm ? warm.state : '—')
    debugSet('warmIndex', warm && warm.pool ? '#' + warm.index + ' / ' + warm.pool.length : '—')
    debugSet(
      'warmReady',
      warm && warmEl && warmEl.dataset.clip === warm.clip
        ? 'rs' + warmEl.readyState + (warmEl.readyState >= 2 ? ' 可播' : ' 未就绪')
        : '—',
    )
    debugSet('boundary', warm ? '态不变→用预载，态变了→现抽' : '剩 1.2s 时才开始预载')

    var sub = document.getElementById('dgt-debug-sub')
    if (sub) {
      // 空字段直接跳过：没起播时 currentChosenState 是空串，别留下两个连着的圆点。
      var parts = [
        mode,
        transition === 'cross' ? '直接叠淡' : '过暗一闪',
        currentChosenState,
        sourceKind,
        hasStarted ? '' : '未起播',
      ]
      sub.textContent = parts.filter(function (part) {
        return part !== ''
      }).join(' · ')
    }

    renderDebugPool()
  }

  /** 桶成员铺开：▶ 当前，⏭ 预载目标。整行 chip，长名字自动换行。 */
  function renderDebugPool() {
    if (!debugPoolEl) return
    if (!currentPool || currentPool.length === 0) {
      debugPoolEl.textContent = '（还没有桶）'
      return
    }
    var warmIndex = warmPlan && warmPlan.pool === currentPool ? warmPlan.index : -1
    var key = currentPool.join('|') + '@' + currentIndex + '@' + warmIndex
    if (debugPoolEl.dataset.key === key) return
    debugPoolEl.dataset.key = key
    debugPoolEl.textContent = ''
    for (var i = 0; i < currentPool.length; i += 1) {
      var chip = document.createElement('span')
      var mark = ''
      chip.className = 'dgt-debug-chip'
      if (i === currentIndex) {
        chip.className += ' is-current'
        mark = '▶ '
      } else if (i === warmIndex) {
        chip.className += ' is-warm'
        mark = '⏭ '
      }
      chip.textContent = mark + currentPool[i]
      debugPoolEl.appendChild(chip)
    }
  }

  function buildHost() {
    if (host) return

    var stage = document.createElement('div')
    stage.id = 'dgt-stage'

    pools = normalizePools()
    for (var slot = 0; slot < 2; slot += 1) {
      var el = makeVideoElement('dgt-video-' + (slot === 0 ? 'a' : 'b'))
      // 起播前先藏起来：有 src 之前元素会画成一块黑
      el.setAttribute('data-hide', '')
      videos.push(el)
      stage.appendChild(el)
    }
    video = videos[0]

    // 遮盖层压在两个 video 之上，但仍在 stage 里：只盖视频那一块，不碰右区玻璃。
    dipEl = document.createElement('div')
    dipEl.id = 'dgt-dip'
    stage.appendChild(dipEl)

    var glass = document.createElement('div')
    glass.id = 'dgt-glass'

    scrimSide = document.createElement('div')
    scrimSide.id = 'dgt-scrim-side'
    scrimConv = document.createElement('div')
    scrimConv.id = 'dgt-scrim-conv'
    sheet = document.createElement('div')
    sheet.id = 'dgt-sheet'
    seam = document.createElement('div')
    seam.id = 'dgt-seam'
    glow = document.createElement('div')
    glow.id = 'dgt-glow'

    glass.appendChild(scrimSide)
    glass.appendChild(scrimConv)
    glass.appendChild(sheet)
    // 收边带压在视频一侧，所以排在玻璃之后叠上去；光源最后画，
    // 这样它同时盖住收边带和玻璃，三者才读成同一盏灯。
    glass.appendChild(seam)
    glass.appendChild(glow)

    body.appendChild(stage)
    body.appendChild(glass)
    host = { stage: stage, glass: glass }

    if (typeof CONFIG.focusX === 'number' && typeof CONFIG.focusY === 'number') {
      document.documentElement.style.setProperty(
        '--dgt-focus',
        CONFIG.focusX + '% ' + CONFIG.focusY + '%',
      )
    }
    if (typeof CONFIG.sidebarDim === 'number') DIM_MODES.dark.side = CONFIG.sidebarDim
    if (typeof CONFIG.convDim === 'number') DIM_MODES.dark.conv = CONFIG.convDim
    if (typeof CONFIG.glow === 'number') DIM_MODES.dark.glow = CONFIG.glow
    BASE_RAMP = getComputedStyle(document.documentElement).getPropertyValue('--dgt-sheet-ramp').trim()
    applyMode(readMode(), false)
    applyTransition(readTransition(), false)
  }

  /**
   * 摆放视频：铺满整个窗口，用裁切换取景，不做无谓的缩放。
   *
   * 判据只有一个——**按设备像素算覆盖**：先把窗口换算成物理像素，
   * 求出 cover 所必需的缩放。这个值就是全屏能拿到的最清晰解：
   *   - 窗口比素材小（常见）→ 缩小，清晰度只增不减；
   *   - 窗口比素材大（2 倍屏塞 1440 行）→ 只能放大这么一点点，
   *     这是素材分辨率的上限，不是排版造成的。
   * 没有任何"先缩小再放大"的中间步骤。
   */
  /**
   * 让布局列本身让开底色。
   *
   * 光把我们自己的层画上去不够：AppFrame 的每一列自己还画着一层不透明底色
   * （侧栏列实测 rgb(249,250,251)），它盖在视频上面，视频就只剩对话栏能看到。
   * 这里按"直接子元素 + 尺寸贴近整列"的判据逐列找，改成行内透明，
   * 关掉时逐个还原——不依赖 CSS Modules 的哈希类名。
   */
  var clearedColumns = []
  var observedFrame = null

  function clearColumnBackgrounds(frame) {
    if (!frame) return
    var limit = frame.getBoundingClientRect()
    var stack = [frame]
    while (stack.length > 0) {
      var node = stack.pop()
      var children = node.children || []
      for (var i = 0; i < children.length; i += 1) {
        var child = children[i]
        var rect = child.getBoundingClientRect()
        if (rect.width < 24 || rect.height < 24) continue
        var style = getComputedStyle(child)
        var opaque = style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent'
        var coversColumn = rect.width >= limit.width * 0.08 && rect.height >= limit.height * 0.5
        if (opaque && coversColumn && !isCleared(child)) {
          clearedColumns.push({ el: child, prev: child.style.backgroundColor })
          child.style.setProperty('background-color', 'transparent', 'important')
        }
        // 只往下钻两层：列 → 列里的容器，够到滚动区即可，不扫整棵会话树。
        if (node === frame) stack.push(child)
      }
    }
  }

  function isCleared(el) {
    for (var i = 0; i < clearedColumns.length; i += 1) {
      if (clearedColumns[i].el === el) return true
    }
    return false
  }

  function restoreColumnBackgrounds() {
    for (var i = 0; i < clearedColumns.length; i += 1) {
      var item = clearedColumns[i]
      if (!item.el || !item.el.style) continue
      item.el.style.backgroundColor = item.prev
      if (item.borderPrev !== undefined) item.el.style.borderRight = item.borderPrev
    }
    clearedColumns = []
  }

  /**
   * 列与列之间的 1px 分隔线会横穿视频，把侧栏切成一块独立面板。
   * 画面已经被 scrim 拉开层次，不需要这条线，开时抹掉、关时还原。
   */
  function clearColumnBorders(frame) {
    if (!frame) return
    var children = frame.children || []
    for (var i = 0; i < children.length; i += 1) {
      var child = children[i]
      var style = getComputedStyle(child)
      if (parseFloat(style.borderRightWidth) > 0 && style.borderRightStyle !== 'none') {
        var entry = null
        for (var k = 0; k < clearedColumns.length; k += 1) {
          if (clearedColumns[k].el === child) entry = clearedColumns[k]
        }
        if (!entry && !isCleared(child)) {
          entry = { el: child, prev: child.style.backgroundColor }
          clearedColumns.push(entry)
        }
        entry.borderPrev = child.style.borderRight
        child.style.setProperty('border-right', '0', 'important')
      }
    }
  }

  /**
   * 右区左缘那条 0.2 白的分隔线：右栏 tab 宿主自带的 border-left，位置刚好落在
   * 视频与右区的交界上，在暗画面里就是一根从顶到底的亮线，读成"布局被切成两段"。
   * 不按类名猜（那是 CSS Module 的哈希，换版本就变），按坐标现找：从交界点
   * 往祖先方向走，谁有左边框、且左缘就压在交界上，就抹掉它。
   */
  function clearEdgeBorder(x, height) {
    if (!(x > 1)) return
    var y = Math.round(height / 2)
    // 不能用"从交点往祖先走"：面板的边框在兄弟节点上，交点本身是个透明的拖拽把手，
    // 它的祖先里根本没有这条边框。elementsFromPoint 给的是该点下方的全部元素栈，
    // 才找得到真正画线的那个。
    var stack = document.elementsFromPoint ? document.elementsFromPoint(Math.round(x) + 1, y) : []
    for (var i = 0; i < stack.length; i += 1) {
      var el = stack[i]
      if (!el || el.nodeType !== 1 || !el.style) continue
      if (String(el.id || '').indexOf('dgt-') === 0) continue
      var rect = el.getBoundingClientRect()
      if (Math.abs(rect.left - x) > 1.5) continue
      var style = getComputedStyle(el)
      if (parseFloat(style.borderLeftWidth) > 0 && style.borderLeftStyle !== 'none') {
        el.style.setProperty('border-left', '0', 'important')
      }
    }
  }

  /**
   * 观感模式：dark / beautify。
   *
   * 只改两个 CSS 变量（`--dgt-side-dim` / `--dgt-conv-dim`），不动 DOM，也不碰视频本身——
   * 所以切换是瞬时的、无损的、可逆的：素材一个像素都没被重新编码。
   * dark 压 0.48/0.54 保证文字对比度；beautify 全撤，恢复素材原本的肤色和打光。
   */
  function applyMode(next, persist) {
    var name = next === 'beautify' ? 'beautify' : 'dark'
    var dims = DIM_MODES[name] || DIM_MODES.dark
    mode = name
    document.documentElement.setAttribute('data-dgt-mode', name)
    document.documentElement.style.setProperty('--dgt-side-dim', String(dims.side))
    document.documentElement.style.setProperty('--dgt-conv-dim', String(dims.conv))
    document.documentElement.style.setProperty('--dgt-glow', String(dims.glow))
    // 玻璃色阶跟着模式走：dark 用压过的色阶，beautify 换回 CSS 里的原值。
    var ramp = name === 'dark' ? DARK_RAMP : BASE_RAMP
    if (ramp) document.documentElement.style.setProperty('--dgt-sheet-ramp', ramp)
    if (persist) persistConfig({ beautify: name === 'beautify' })
    renderDebug()
    notifyConfig()
    return mode
  }

  function readMode() {
    return CONFIG.beautify === true ? 'beautify' : 'dark'
  }

  function toggleMode() {
    return applyMode(mode === 'dark' ? 'beautify' : 'dark', true)
  }

  /**
   * 换片过渡方式。
   *
   * `dip` 先压一段暗盖住画面、盖满的那一刻换元素、再揭开；`cross` 是两段直接叠着淡。
   * 前者掩盖的是素材本身的差异（人物位置/姿态不一样，叠着淡会看出两个影子），
   * 后者留着做对照。都只动元素可见性，不重新编码素材。
   */
  function applyTransition(next, persist) {
    var name = next === 'cross' ? 'cross' : 'dip'
    transition = name
    if (dipEl && name === 'cross') {
      // 切到 cross 时把遮盖层归零，否则上一次过暗留下的半透明会一直挂着
      dipEl.style.transition = 'none'
      dipEl.style.opacity = '0'
    }
    if (persist) persistConfig({ transition: name })
    renderDebug()
    notifyConfig()
    return transition
  }

  function readTransition() {
    return CONFIG.transition === 'cross' ? 'cross' : 'dip'
  }

  function toggleTransition() {
    return applyTransition(transition === 'dip' ? 'cross' : 'dip', true)
  }

  /**
   * 把一次改动写回配置文件（唯一真相源）。
   * 失败只 warn：页面侧的观感已经改了，不该因为落盘失败又弹回去。
   */
  function persistConfig(patch) {
    var url = typeof CONFIG.configUrl === 'string' ? CONFIG.configUrl : ''
    if (url === '' || typeof fetch !== 'function') return
    try {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
        .then(function (res) {
          if (!res.ok) warn('配置保存失败：HTTP ' + res.status)
        })
        .catch(function (error) {
          warn('配置保存失败：' + String(error))
        })
    } catch (error) {
      warn('配置保存失败：' + String(error))
    }
  }

  /** 通知同页的设置卡片：配置变了（快捷键改的那一次），让开关跟着走。 */
  function notifyConfig() {
    try {
      CONFIG.debug = debugEl !== null
      CONFIG.beautify = mode === 'beautify'
      CONFIG.transition = transition
      document.dispatchEvent(
        new CustomEvent('dgt-config', {
          detail: { beautify: CONFIG.beautify, debug: CONFIG.debug, transition: transition },
        }),
      )
    } catch (e) {}
  }

  /**
   * 调试浮窗开关。
   * @param {boolean} on
   * @param {boolean} [persist]
   */
  function setDebug(on, persist) {
    if (on) startDebug()
    else stopDebug()
    if (persist !== false) persistConfig({ debug: on === true })
    notifyConfig()
    return on === true
  }

  function placeVideo(regionW, cssH, offsetX) {
    if (videos.length === 0 || !host || !host.stage) return
    var fx = typeof CONFIG.focusX === 'number' ? CONFIG.focusX : 78
    var fy = typeof CONFIG.focusY === 'number' ? CONFIG.focusY : 40

    // 尺寸交给 CSS：视频永远铺满 stage（100%×100%），多余部分由 object-fit:cover 裁掉。
    // 不写 px 宽高——写了就得靠 JS 追每一次窗口变化，追漏一次就是"窗口变大、视频没变"。
    // 现在窗口怎么变，浏览器自己重排，JS 只需要改 stage 的宽度（=接缝位置）。
    var focus = fx + '% ' + fy + '%'
    videos.forEach(function (el) {
      el.style.objectFit = 'cover'
      el.style.objectPosition = focus
      el.style.width = '100%'
      el.style.height = '100%'
      el.style.left = '0px'
      el.style.top = '0px'
      el.setAttribute('data-focus', fx + '%/' + fy + '%')
    })
    host.stage.style.left = (offsetX || 0) + 'px'
    host.stage.style.top = '0px'
    host.stage.style.width = Math.max(0, Math.round(regionW)) + 'px'
    host.stage.style.height = Math.max(0, Math.round(cssH)) + 'px'
  }

  function applyLayout() {
    var viewportWidth = document.documentElement.clientWidth || innerWidth || 0
    // 标签页还没排版时 clientWidth 是 0，这时候算出来的宽度会把视频压成 0，
    // 等 resize 再算一次就行，别把坏值写进样式。
    if (viewportWidth < 1) return

    var el = findFrame()
    if (!el) {
      // 没有会话（首页/工作区空态）时没有三栏 grid。此时退回整屏视频，
      // 只保留一层均匀压暗，不画右侧玻璃——否则半块玻璃会凭空怼在画面中间。
      var stageHeightFallback = document.documentElement.clientHeight || innerHeight || 0
      placeVideo(viewportWidth, stageHeightFallback, 0)
      scrimSide.style.width = '0px'
      scrimConv.style.left = '0px'
      scrimConv.style.width = viewportWidth + 'px'
      sheet.style.display = 'none'
      seam.style.display = 'none'
      glow.style.display = 'none'
      return
    }
    clearColumnBackgrounds(el)
    clearColumnBorders(el)
    var rect = el.getBoundingClientRect()
    var tracks = readTracks(el)

    var sideWidth = tracks[0] || 0
    var convWidth = tracks[1] || 0
    var workWidth = tracks.length > 2 ? tracks[2] || 0 : 0
    if (sideWidth <= 0) sideWidth = 280

    // 参考原点：布局框左边（一般就是 0，但不能假设）。
    var left = Math.round(rect.left)
    var videoRight = workWidth > 0 ? Math.round(left + sideWidth + convWidth) : viewportWidth
    var rightWidth = Math.max(0, viewportWidth - videoRight)

    var stageHeight = document.documentElement.clientHeight || innerHeight || 0
    // 视频铺满左+中两栏。注意坐标系：这层是 position:fixed，原点是视口左上角，
    // 所以必须从 0 铺到 videoRight，不能从布局框的 rect.left 起算——
    // 否则侧栏那一截会空出来，看起来就像"视频只铺了对话栏"。
    placeVideo(videoRight, stageHeight, 0)
    scrimSide.style.left = left + 'px'
    scrimSide.style.width = Math.round(sideWidth) + 'px'
    scrimConv.style.left = Math.round(left + sideWidth) + 'px'
    scrimConv.style.width = Math.max(0, videoRight - Math.round(left + sideWidth)) + 'px'
    // 玻璃：videoRight → 窗口右缘，一整块。3/4/5/6 栏共用它，
    // 所以这里只认 videoRight，没有任何"第几栏"的宽度。
    // 左缘往视频里压 2px：页面底色（被让开后的默认白）会从两块不透明层的
    // 亚像素接缝里漏出来，正好落在这条边界上，看上去就是一根亮线。重叠即消失，
    // 2px 都是不透明玻璃色，压在视频最后一列像素上看不出来。
    sheet.style.left = (videoRight - 2) + 'px'
    sheet.style.width = (rightWidth + 2) + 'px'
    // 收边带整条落在视频一侧，右端正好停在 videoRight：它在那里已经是玻璃色，
    // 于是接缝两侧同色，肉眼看到的是一条自然的收边而不是两块板相撞。
    // left 允许为负（窄窗口），色阶几何靠位置保持、靠玻璃层的 overflow:hidden 裁掉。
    seam.style.left = videoRight - SEAM_WIDTH + 'px'
    seam.style.width = SEAM_WIDTH + 'px'
    // 一盏灯：左缘与收边带对齐，只落在右区，不探进视频。
    // 同样允许 left 为负，径向渐变的百分比才会一直贴着接缝、不被夹到右栏里。
    var glowLeft = videoRight - GLOW_LEAD
    glow.style.left = glowLeft + 'px'
    glow.style.width = Math.max(0, viewportWidth - glowLeft) + 'px'

    // 右区面板自己那条左边框也要收掉：它画在玻璃之上，正好压在接缝上。
    clearEdgeBorder(videoRight, stageHeight)

    var visible = rightWidth > 0 ? 'block' : 'none'
    sheet.style.display = visible
    seam.style.display = visible
    glow.style.display = visible
  }

  function schedule() {
    if (rafPending) return
    rafPending = true
    // 不用 requestAnimationFrame：后台标签页/无焦点的 Agent Window 里它会被挂起，
    // 布局就永远算不出来。setTimeout(0) 在任何可见性下都会跑。
    setTimeout(function () {
      rafPending = false
      try {
        applyLayout()
      } catch (error) {
        warn('布局计算失败：' + String(error))
      }
    }, 0)
  }

  /**
   * 深色底色：主题把正文色按 `body[data-ds-dark-theme]` 切换。
   * 视频后面的区域是暗的，所以这里强制挂上；主题自己改回去时再挂一次。
   */
  // 视频底下是暗的，正文必须是深色主题的配色，否则浅色文字落在亮视频上看不清。
  // 强迫归强迫，得记住用户原本是不是深色；关掉时必须还原，不能把人家的主题改掉。
  let darkBeforeForce = null

  function ensureDark() {
    if (!body) return
    if (!body.hasAttribute('data-ds-dark-theme')) {
      if (darkBeforeForce === null) darkBeforeForce = false
      body.setAttribute('data-ds-dark-theme', '')
    } else if (darkBeforeForce === null) {
      darkBeforeForce = true
    }
  }

  function restoreDark() {
    if (darkBeforeForce === null) return
    if (!darkBeforeForce && body) body.removeAttribute('data-ds-dark-theme')
    darkBeforeForce = null
  }

  function observeFrame() {
    if (!resizeObserver) return
    var el = findFrame()
    if (el === observedFrame) return
    if (observedFrame) {
      try {
        resizeObserver.unobserve(observedFrame)
      } catch (error) {
        /* 元素可能已经不在文档里，忽略 */
      }
    }
    observedFrame = el
    if (el) resizeObserver.observe(el)
  }

  function watch() {
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(function () {
        schedule()
      })
      observeFrame()
    }
    if (typeof MutationObserver === 'function') {
      mutationObserver = new MutationObserver(function () {
        ensureDark()
        observeFrame()
        schedule()
      })
      mutationObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-ds-dark-theme', 'class', 'style'],
        subtree: true,
        childList: true,
      })
    }
    // 三条都挂：窗口改尺寸（浏览器拖框）、visualViewport（缩放手势/移动端）、
    // 以及 DPR 变化（拖到另一块缩放不同的显示器）——任一条都能把尺寸拉回来。
    addEventListener('resize', schedule, { passive: true })
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', schedule, { passive: true })
    }
    if (window.matchMedia) {
      var dprQuery = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)')
      var onDpr = function () {
        schedule()
        if (typeof dprQuery.removeEventListener === 'function') {
          dprQuery.removeEventListener('change', onDpr)
        }
        watchDpr()
      }
      var watchDpr = function () {
        dprQuery = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)')
        if (typeof dprQuery.addEventListener === 'function') dprQuery.addEventListener('change', onDpr)
      }
      watchDpr()
    }
  }

  function enable() {
    enabled = true
    document.documentElement.setAttribute(HTML_ATTR, 'on')
    buildHost()
    ensureDark()
    schedule()
    watch()
    startStateStream()
    if (CONFIG.debug === true) startDebug()
    ensurePlaying('启动')
    // 后台标签页里 Chrome 会把媒体加载挂起（readyState 一直是 0、canplay 永远不来），
    // 回到前台再推一次；4 秒还空着也补一次，免得页面整块黑着没人知道为什么。
    setTimeout(function () {
      ensurePlaying('4s 无画面')
    }, 4000)
  }

  /**
   * 起播兜底。canplay 不来时 playClip 已经发了 src，但 hasStarted 还是 false，
   * 这时再决定一段、再挂一次 canplay 是唯一能自救的动作；最多重试 3 次，别变成死循环。
   */
  function ensurePlaying(reason) {
    if (!host) return
    if (hasStarted) return
    if (startAttempts >= 3) {
      logDebug('仍无画面（' + reason + '），已重试 ' + startAttempts + ' 次')
      return
    }
    startAttempts += 1
    logDebug('起播（' + reason + '）')
    playClip(decideNext())
  }

  function disable() {
    enabled = false
    if (boundaryWatch) {
      cancelAnimationFrame(boundaryWatch)
      boundaryWatch = 0
    }
    advancing = false
    if (dipEl) {
      dipEl.style.transition = 'none'
      dipEl.style.opacity = '0'
    }
    document.documentElement.removeAttribute(HTML_ATTR)
    restoreDark()
    restoreColumnBackgrounds()
    if (host) {
      stopStateStream()
      stopDebug()
      videos.forEach(function (el) {
        try {
          el.pause()
        } catch (error) {
          /* 暂停失败不影响卸载 */
        }
        el.removeAttribute('data-top')
        el.removeAttribute('data-hide')
        el.removeAttribute('src')
        try {
          el.load()
        } catch (error) {
          /* 忽略 */
        }
      })
      videos.length = 0
      host.stage.remove()
      host.glass.remove()
      host = null
      video = null
      currentClip = ''
      hasStarted = false
      startAttempts = 0
      currentPool = null
      currentIndex = -1
      currentChosenState = ''
      latestSnapshot = null
    }
    if (resizeObserver) {
      resizeObserver.disconnect()
      resizeObserver = null
      observedFrame = null
    }
    if (mutationObserver) {
      mutationObserver.disconnect()
      mutationObserver = null
    }
  }

  function toggle() {
    if (enabled) disable()
    else enable()
  }

  /** 开发钩子：伪造一份快照立即切，用来在不跑真回合时验收素材。 */
  function setState(next) {
    var name = String(next || 'idle')
    sourceKind = 'manual'
    latestSnapshot = {
      seq: (latestSnapshot && typeof latestSnapshot.seq === 'number' ? latestSnapshot.seq : 0) + 1,
      time: Date.now(),
      current: { state: name, isNew: false },
      agents: [],
    }
    state = name
    playClip(decideNext())
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') ensurePlaying('回到前台')
  })

  addEventListener('keydown', function (event) {
    if (!event.ctrlKey || !event.altKey) return
    // 认字母只能用 code，不能用 key：macOS 的 Option(⌥) 是输入修饰键，按住 ⌥ 时
    // key 已被改写成它要输入的字符（⌥B →「∫」、⌥M →「µ」），`key === 'b'` 在 mac
    // 上永远不成立。code 是物理键位，不随布局和修饰键变化。
    var byCode = /^Key([A-Z])$/.exec(String(event.code || ''))
    var key = byCode ? byCode[1].toLowerCase() : String(event.key || '').toLowerCase()
    if (key === 'b') {
      event.preventDefault()
      toggle()
    } else if (key === 'm') {
      event.preventDefault()
      toggleMode()
    } else if (key === 't') {
      event.preventDefault()
      toggleTransition()
    }
  })

  function boot() {
    body = document.body
    if (!body) return
    if (CONFIG.enabled === false) return
    enable()
  }

  globalThis.__DGT_API__ = {
    enable: enable,
    disable: disable,
    toggle: toggle,
    relayout: schedule,
    setState: setState,
    setMode: applyMode,
    toggleMode: toggleMode,
    setDebug: setDebug,
    setTransition: applyTransition,
    toggleTransition: toggleTransition,
    retryPlay: function () {
      startAttempts = 0
      ensurePlaying('手动重试')
    },
    get debug() {
      return debugEl !== null
    },
    get mode() {
      return mode
    },
    get transition() {
      return transition
    },
    get state() {
      return state
    },
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
})()
