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

  if (globalThis.__SVB_INSTALLED__) return
  globalThis.__SVB_INSTALLED__ = true

  var CONFIG = globalThis.__DSH_STATE_VIDEO_BG__
  if (!CONFIG || typeof CONFIG !== 'object') CONFIG = {}

  var HTML_ATTR = 'data-svb'
  /** 接缝收边带宽度：整条叠在视频上，一个像素都不进右栏。 */
  var SEAM_WIDTH = 220
  /** 光源往接缝左侧伸出的距离：灯要跨过接缝，落在视频右下角。 */
  var GLOW_LEAD = 200
  var body = null
  var host = null
  var frame = null
  var video = null
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

  function buildHost() {
    if (host) return

    var stage = document.createElement('div')
    stage.id = 'svb-stage'

    video = document.createElement('video')
    video.id = 'svb-video'
    video.autoplay = true
    video.loop = true
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.setAttribute('muted', '')
    video.setAttribute('playsinline', '')
    video.setAttribute('aria-hidden', 'true')
    if (typeof CONFIG.videoUrl === 'string' && CONFIG.videoUrl !== '') {
      video.src = CONFIG.videoUrl
    }
    video.addEventListener('loadedmetadata', function () {
      schedule()
    })
    video.addEventListener('loadeddata', function () {
      video.setAttribute('data-shown', '1')
      var played = video.play()
      if (played && typeof played.catch === 'function') {
        played.catch(function (error) {
          warn('视频未能自动播放：' + String(error))
        })
      }
    })
    video.addEventListener('error', function () {
      warn('视频加载失败，保持原生外观：' + String(video.src))
    })
    stage.appendChild(video)

    var glass = document.createElement('div')
    glass.id = 'svb-glass'

    scrimSide = document.createElement('div')
    scrimSide.id = 'svb-scrim-side'
    scrimConv = document.createElement('div')
    scrimConv.id = 'svb-scrim-conv'
    sheet = document.createElement('div')
    sheet.id = 'svb-sheet'
    seam = document.createElement('div')
    seam.id = 'svb-seam'
    glow = document.createElement('div')
    glow.id = 'svb-glow'

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
        '--svb-focus',
        CONFIG.focusX + '% ' + CONFIG.focusY + '%',
      )
    }
    if (typeof CONFIG.sidebarDim === 'number') {
      document.documentElement.style.setProperty('--svb-side-dim', String(CONFIG.sidebarDim))
    }
    if (typeof CONFIG.convDim === 'number') {
      document.documentElement.style.setProperty('--svb-conv-dim', String(CONFIG.convDim))
    }
    if (typeof CONFIG.glow === 'number') {
      document.documentElement.style.setProperty('--svb-glow', String(CONFIG.glow))
    }
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

  function placeVideo(regionW, cssH, offsetX) {
    if (!video || !host || !host.stage) return
    var fx = typeof CONFIG.focusX === 'number' ? CONFIG.focusX : 78
    var fy = typeof CONFIG.focusY === 'number' ? CONFIG.focusY : 40

    // 尺寸交给 CSS：视频永远铺满 stage（100%×100%），多余部分由 object-fit:cover 裁掉。
    // 不写 px 宽高——写了就得靠 JS 追每一次窗口变化，追漏一次就是"窗口变大、视频没变"。
    // 现在窗口怎么变，浏览器自己重排，JS 只需要改 stage 的宽度（=接缝位置）。
    video.style.objectFit = 'cover'
    video.style.objectPosition = fx + '% ' + fy + '%'
    video.style.width = '100%'
    video.style.height = '100%'
    video.style.left = '0px'
    video.style.top = '0px'
    host.stage.style.left = (offsetX || 0) + 'px'
    host.stage.style.top = '0px'
    host.stage.style.width = Math.max(0, Math.round(regionW)) + 'px'
    host.stage.style.height = Math.max(0, Math.round(cssH)) + 'px'
    video.setAttribute('data-focus', fx + '%/' + fy + '%')
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
    sheet.style.left = videoRight + 'px'
    sheet.style.width = rightWidth + 'px'
    // 收边带整条落在视频一侧，右端正好停在 videoRight：它在那里已经是玻璃色，
    // 于是接缝两侧同色，肉眼看到的是一条自然的收边而不是两块板相撞。
    // left 允许为负（窄窗口），色阶几何靠位置保持、靠玻璃层的 overflow:hidden 裁掉。
    seam.style.left = videoRight - SEAM_WIDTH + 'px'
    seam.style.width = SEAM_WIDTH + 'px'
    // 一盏灯：从接缝左侧 200px 起跨过接缝，和人物脚下的光连成一片。
    // 同样允许 left 为负，径向渐变的百分比才会一直贴着接缝、不被夹到右栏里。
    var glowLeft = videoRight - GLOW_LEAD
    glow.style.left = glowLeft + 'px'
    glow.style.width = Math.max(0, viewportWidth - glowLeft) + 'px'

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
  }

  function disable() {
    enabled = false
    document.documentElement.removeAttribute(HTML_ATTR)
    restoreDark()
    restoreColumnBackgrounds()
    if (host) {
      if (video) {
        try {
          video.pause()
        } catch (error) {
          /* 暂停失败不影响卸载 */
        }
        video.removeAttribute('src')
        video.load()
      }
      host.stage.remove()
      host.glass.remove()
      host = null
      video = null
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

  /** S2 会用到：宿主推 SSE 后调它切素材。阶段一只记录。 */
  function setState(next) {
    state = String(next || 'idle')
  }

  addEventListener('keydown', function (event) {
    if (event.ctrlKey && event.altKey && (event.key === 'b' || event.key === 'B')) {
      event.preventDefault()
      toggle()
    }
  })

  function boot() {
    body = document.body
    if (!body) return
    if (CONFIG.enabled === false) return
    enable()
  }

  globalThis.__DSH_STATE_VIDEO_BG_API__ = {
    enable: enable,
    disable: disable,
    toggle: toggle,
    relayout: schedule,
    setState: setState,
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
