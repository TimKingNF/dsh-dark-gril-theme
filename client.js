/**
 * dsh-dark-gril-theme 的浏览器半边：设置面板左侧的一个顶层选项页。
 *
 * 挂载方式抄 dsh-tdai-memory-plugin 的同一套公开接口：
 *   - 包 package.json 声明 `dsh.client.platform = "web"` 与 `./client` 导出；
 *   - 本文件是客户端模块系统的 lazy-CJS factory（`window.__ModuleLoader__.load`）；
 *   - 导出 { name, inject: ['slots'], apply }，在 `settings.section` 槽里注册一页。
 *
 * 配置只有一个真相源：宿主的 `/dsh-dark-gril-theme/config.json`。
 * 卡片 GET 它拿当前值、POST 它改值，再让页面里已经注入的运行时立即生效。
 * 为什么不用 ctx.configForms：那套要求宿主导出 Schemastery Config 并把值写进
 * profile patch，本插件没有这个依赖，也不打算让一个观感开关去改 profile。
 *
 * 手写、不打包：两个开关不值得引 esbuild + React 构建链，改完刷新即生效。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dark-gril-theme',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    /** 宿主路由，与 index.js 的 CONFIG_ROUTE 一致。 */
    const CONFIG_URL = '/dsh-dark-gril-theme/config.json'
    /** 设置页命名空间 = 本插件名。 */
    const SECTION_ID = 'dsh-dark-gril-theme'

    /** 两个开关的文案；键名与 lib/config.js 的白名单一致。 */
    const FIELDS = [
      {
        key: 'beautify',
        label: '打光模式',
        hint: '开 = beautify：撤掉侧栏与对话区的暗蒙版，恢复素材原本的肤色和光斑。关 = dark：0.48 / 0.54 的可读版压暗。只改 CSS 变量，视频不重新编码。',
      },
      {
        key: 'debug',
        label: '调试浮窗',
        hint: '右下角常驻诊断：当前快照态、正在播的素材与进度、预载目标、状态来源（sse / poll / manual）。',
      },
    ]

    // DS Bot 皮肤把 --dsw-alias-label-primary 定义成 #121826（给浅面板的反色），
    // 拿它当前景色会在深色设置面板上变成隐形字幕。前景一律继承面板自身的文字色。
    const C = {
      border: '1px solid rgba(127,127,127,0.35)',
      borderSoft: '1px solid rgba(127,127,127,0.22)',
      primary: 'inherit',
      secondary: 'inherit',
      tertiary: 'inherit',
      dim: 0.62,
      track: 'rgba(127,127,127,0.35)',
      trackOn: '#3b82f6',
      knob: '#ffffff',
    }

    /** 把一次改动推给页面里已注入的运行时；没有运行时（未注入）就只留配置。 */
    function applyLive(key, value) {
      const api = globalThis.__DGT_API__
      if (api === undefined || api === null) return
      try {
        if (key === 'beautify' && typeof api.setMode === 'function') {
          api.setMode(value === true ? 'beautify' : 'dark', false)
        }
        if (key === 'debug' && typeof api.setDebug === 'function') {
          api.setDebug(value === true, false)
        }
      } catch {
        /* 运行时自己坏了不该顶掉设置页 */
      }
    }

    /** 一个开关：button + role=switch，键盘可点，样式跟设置页主题走。 */
    function Switch(props) {
      const on = props.on === true
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          'aria-label': props.label,
          disabled: props.disabled === true,
          onClick: props.onToggle,
          style: {
            appearance: 'none',
            flex: 'none',
            position: 'relative',
            width: '38px',
            height: '22px',
            marginTop: '1px',
            padding: '0',
            border: 'none',
            borderRadius: '11px',
            cursor: props.disabled === true ? 'progress' : 'pointer',
            background: on ? C.trackOn : C.track,
            opacity: props.disabled === true ? 0.6 : 1,
            transition: 'background 120ms ease',
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: '3px',
            left: on ? '19px' : '3px',
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            background: C.knob,
            boxShadow: '0 1px 2px rgba(0,0,0,0.35)',
            transition: 'left 120ms ease',
          },
        }),
      )
    }

    function Row(props) {
      const field = props.field
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: '12px',
            padding: '12px 0',
            borderBottom: C.borderSoft,
          },
        },
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: '0' } },
          h('div', { style: { fontSize: '13px', lineHeight: '1.5', color: C.primary } }, field.label),
          h(
            'div',
            { style: { marginTop: '4px', fontSize: '12px', lineHeight: '1.55', color: C.tertiary, opacity: C.dim } },
            field.hint,
          ),
        ),
        h(Switch, {
          on: props.value === true,
          disabled: props.disabled,
          label: field.label,
          onToggle: () => props.onChange(!(props.value === true)),
        }),
      )
    }

    function Card() {
      const [status, setStatus] = React.useState('loading')
      const [config, setConfig] = React.useState(null)
      const [error, setError] = React.useState('')
      const [saving, setSaving] = React.useState('')

      React.useEffect(() => {
        let alive = true
        fetch(CONFIG_URL, { cache: 'no-store' })
          .then((res) => {
            if (!res.ok) throw new Error('HTTP ' + res.status)
            return res.json()
          })
          .then((json) => {
            if (!alive) return
            setConfig(json)
            setStatus('ready')
          })
          .catch((err) => {
            if (!alive) return
            setError(String(err && err.message ? err.message : err))
            setStatus('error')
          })
        return () => {
          alive = false
        }
      }, [])

      // 快捷键（Ctrl+Alt+M / 切调试）改的是同一份配置，这里跟着同步，避免开关显示旧值。
      React.useEffect(() => {
        const onSync = (event) => {
          const detail = event && event.detail
          if (!detail) return
          setConfig((prev) => (prev === null ? prev : Object.assign({}, prev, detail)))
        }
        document.addEventListener('dgt-config', onSync)
        return () => document.removeEventListener('dgt-config', onSync)
      }, [])

      function change(key, value) {
        const previous = config === null ? undefined : config[key]
        setConfig((prev) => (prev === null ? prev : Object.assign({}, prev, { [key]: value })))
        setSaving(key)
        setError('')
        const payload = {}
        payload[key] = value
        fetch(CONFIG_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          cache: 'no-store',
        })
          .then(async (res) => {
            const body = await res.json().catch(() => null)
            if (!res.ok) {
              throw new Error(body && body.error ? String(body.error) : 'HTTP ' + res.status)
            }
            if (body && body.config) setConfig(body.config)
            applyLive(key, value)
          })
          .catch((err) => {
            // 落盘失败就退回旧值，别让开关显示一个没保存的状态。
            setConfig((prev) => (prev === null ? prev : Object.assign({}, prev, { [key]: previous })))
            setError('保存失败：' + String(err && err.message ? err.message : err))
          })
          .finally(() => setSaving(''))
      }

      const rows = FIELDS.map((field) =>
        h(Row, {
          key: field.key,
          field: field,
          value: config === null ? false : config[field.key],
          disabled: status !== 'ready' || saving === field.key,
          onChange: (next) => change(field.key, next),
        }),
      )

      return h(
        'div',
        { style: { maxWidth: '760px', padding: '4px 0 16px' } },
        h('h2', { style: { margin: '0 0 6px', fontSize: '15px', fontWeight: 600, color: C.primary } }, 'Dark Gril 主题'),
        h(
          'p',
          { style: { margin: '0 0 8px', fontSize: '12px', lineHeight: '1.6', color: C.tertiary, opacity: C.dim } },
          '按会话状态切换的背景视频层。改动即时生效，保存在 $DSH_HOME/dsh-dark-gril-theme.json，刷新页面或重启 DSH 后仍保持。',
        ),
        status === 'loading'
          ? h('div', { style: { padding: '12px 0', fontSize: '12px', color: C.tertiary, opacity: C.dim } }, '读取配置…')
          : null,
        status === 'error'
          ? h(
              'div',
              {
                style: {
                  margin: '8px 0',
                  padding: '8px 10px',
                  border: C.border,
                  borderRadius: '8px',
                  fontSize: '12px',
                  lineHeight: '1.5',
                  color: C.secondary,
                },
              },
              '读不到配置文件（' + error + '），开关不可用。确认插件已启用后刷新页面。',
            )
          : null,
        status === 'ready'
          ? h('div', null, rows,
              error
                ? h('div', { style: { marginTop: '10px', fontSize: '12px', color: 'var(--dsw-alias-label-warning, #b7791f)' } }, error)
                : null)
          : null,
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: 260,
            label: () => 'Dark Gril 主题',
          },
          Card,
        ),
      )
    }

    module.exports = { name: 'dsh-dark-gril-theme-client', inject: ['slots'], apply }
    return module.exports
  },
})
