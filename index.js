/**
 * dsh-dark-gril-theme —— 宿主半边（阶段一：固定视频 + 主题材质）。
 *
 * 只做两件事：
 *   ① 给 `webserver/index-inject` 贡献两行注入（样式 + 运行时脚本），页面加载时把
 *      视频层与玻璃层挂到 `document.body` 上；
 *   ② 用支持 Range 的路由把素材发给浏览器，并给一份运行期配置。
 *
 * 阶段一不含状态机：视频固定播 idle，切换逻辑留到 S2（host 侧订阅事件、client 走 SSE）。
 *
 * 三条硬约束（抄自 dsh-video-skin 的踩坑记录，都是"插件出问题时不能连累 DSH 起来"）：
 *   - `inject` 为空数组、不 import 任何 DSH 包：对象级 inject 会把 apply 推迟，
 *     而注入表在宿主启动时收集一次，晚到的订阅永远进不了表。
 *   - 只推 `kind:'script'`，绝不用 `kind:'script-src'`：后者失败会 reject，
 *     把 `__DSH_BOOT_READY__` 打掉，整个应用起不来。
 *   - 任何一步失败都只 warn 并跳过，不向上抛。
 */
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULTS, readConfig, writeConfig } from './lib/config.js'
import { POOLS, pickNext } from './lib/pools.js'
import { contentTypeFor, parseRange, resolveInside, toInlineJson } from './lib/route.js'
import { installStateService } from './lib/state-service.js'

/** Cordis 诊断用的插件名。 */
export const name = 'dark-gril-theme'

/** 没有必需服务：`webServer` 迟到接入，不阻塞 apply。 */
export const inject = []

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url))
export const ASSET_DIR = path.join(PACKAGE_ROOT, 'assets')
const RUNTIME_DIR = path.join(PACKAGE_ROOT, 'runtime')

/** 所有路由共享的前缀。 */
export const ROUTE_PREFIX = '/dsh-dark-gril-theme'
/** 运行期配置。 */
export const CONFIG_ROUTE = `${ROUTE_PREFIX}/config.json`
/** 素材前缀。 */
export const VIDEO_PREFIX = `${ROUTE_PREFIX}/videos/`
/** 状态推送（SSE，`text/event-stream`）。 */
export const STATE_ROUTE = `${ROUTE_PREFIX}/state`
/** 状态快照（JSON，SSE 断掉时页面降级轮询它）。 */
export const STATE_JSON_ROUTE = `${ROUTE_PREFIX}/state.json`
/** 页面侧读取配置用的全局名。 */
export const BOOTSTRAP_GLOBAL = '__DGT__'

/**
 * 读运行期配置。真相源与校验规则都在 lib/config.js：`$DSH_HOME/dsh-dark-gril-theme.json`
 * 存在时覆盖默认值，坏文件、坏键都退化成默认值，不抛错。
 *
 * @param {string} dshHome
 * @returns {Record<string, unknown>}
 */
function loadConfig(dshHome) {
  return readConfig(dshHome, warn)
}

/**
 * DSH_HOME：`$DSH_HOME` 优先，否则 `~/.dsh`。
 * @returns {string}
 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return path.join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.dsh')
}

/** @param {unknown} message */
function warn(message) {
  // 插件自己的告警走 console，不去碰宿主的 logger 接口。
  console.warn(`[dsh-dark-gril-theme] ${message}`)
}

/**
 * 读 runtime/ 下的文本产物；缺失时返回空串（页面侧会自动退化成原生外观）。
 * @param {string} fileName
 * @returns {string}
 */
function readRuntime(fileName) {
  try {
    return readFileSync(path.join(RUNTIME_DIR, fileName), 'utf8')
  } catch (error) {
    warn(`读取 runtime/${fileName} 失败：${String(error)}`)
    return ''
  }
}

/**
 * 素材目录：优先 `$DSH_HOME/dsh-dark-gril-theme/assets`。
 *
 * 素材不随包发（127MB），用户从 GitHub 下载后放这里，升级插件不会覆盖；
 * 目录不存在或一个视频都没有才回落到包内 assets/（本地开发时就是它）。
 *
 * @param {string} dshHome
 * @returns {string}
 */
function resolveAssetDir(dshHome) {
  const userDir = path.join(dshHome, 'dsh-dark-gril-theme', 'assets')
  try {
    if (readdirSync(userDir).some((name) => /\.(webm|mp4)$/iu.test(name))) return userDir
  } catch {
    /* 没这个目录是常态，不是错误 */
  }
  return ASSET_DIR
}

/** 目录 mtime 变了才重读，免得每个视频请求都扫一次盘。 */
let assetCache = { dir: '', mtimeMs: -1, names: new Set() }

/**
 * 素材白名单：只发目录里真实存在的文件。
 * @param {string} dir
 * @returns {Set<string>}
 */
function assetNames(dir) {
  try {
    const mtimeMs = statSync(dir).mtimeMs
    if (assetCache.dir === dir && assetCache.mtimeMs === mtimeMs) return assetCache.names
    const names = new Set(readdirSync(dir))
    assetCache = { dir, mtimeMs, names }
    return names
  } catch (error) {
    warn(`读取素材目录失败：${String(error)}`)
    return new Set()
  }
}

/**
 * 带 Range 的素材响应。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} fileName
 * @param {string} assetDir
 */
function serveAsset(req, res, fileName, assetDir) {
  const allowed = assetNames(assetDir)
  if (!allowed.has(fileName)) {
    res.statusCode = 404
    res.end('not found')
    return
  }
  const target = resolveInside(assetDir, fileName)
  if (target === null) {
    res.statusCode = 403
    res.end('forbidden')
    return
  }
  let stat
  try {
    stat = statSync(target)
  } catch {
    res.statusCode = 404
    res.end('not found')
    return
  }

  const size = stat.size
  const range = parseRange(req.headers.range, size)
  res.setHeader('Content-Type', contentTypeFor(fileName))
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'no-store')

  if (range === 'unsatisfiable') {
    res.statusCode = 416
    res.setHeader('Content-Range', `bytes */${size}`)
    res.end()
    return
  }

  if (range === null) {
    res.statusCode = 200
    res.setHeader('Content-Length', String(size))
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(target).pipe(res)
    return
  }

  const length = range.end - range.start + 1
  res.statusCode = 206
  res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
  res.setHeader('Content-Length', String(length))
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(target, { start: range.start, end: range.end }).pipe(res)
}

/** 一次写入请求体的上限，够两个开关，挡住误发的整文件。 */
const CONFIG_BODY_LIMIT = 64 * 1024

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * 读 JSON 请求体；超限或解析失败返回 `undefined`。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<unknown>}
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > CONFIG_BODY_LIMIT) {
        finish(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(undefined)
      }
    })
    req.on('error', () => finish(undefined))
  })
}

/**
 * 挡掉别的网页打过来的写请求：带了 Origin 且 host 与本机请求不一致就拒。
 * 本机其它进程仍可写——这是本地工具，不做鉴权。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isSameOriginRequest(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * 生成注入行。样式必须排在脚本之前（两种渲染器都按数组顺序应用，没有按 kind 排序）。
 *
 * 轮播规则以函数源码的形式一起注入：页面侧与宿主侧读的是同一个函数，
 * 不会出现"两份规则、改一份忘另一份"。
 *
 * @param {{ clientConfig: Record<string, unknown>, cssText: string, jsText: string }} input
 * @returns {Array<Record<string, unknown>>}
 */
function buildInjectionRows(input) {
  const bootstrap = [
    `globalThis.${BOOTSTRAP_GLOBAL}=${toInlineJson(input.clientConfig)};`,
    `globalThis.__DGT_RULES__={pickNext:${String(pickNext)}};`,
  ].join('\n')
  return [
    { kind: 'style', text: input.cssText },
    { kind: 'script', placement: 'body', text: `${bootstrap}\n${input.jsText}` },
  ]
}

/**
 * 插件入口。
 * @param {any} ctx
 */
export function apply(ctx) {
  const dshHome = resolveDshHome()
  const assetDir = resolveAssetDir(dshHome)

  // ── ① 状态机 ──
  // 事件驱动的部分先于路由挂上：路由只是把当前快照读出去。
  const stateService = installStateService(ctx, { warn })

  // ── ② 注入行 ──
  ctx.on('webserver/index-inject', (table) => {
    if (!Array.isArray(table)) return
    try {
      const config = loadConfig(dshHome)
      if (config.enabled === false) return
      const asset = typeof config.asset === 'string' ? config.asset : DEFAULTS.asset
      const available = [...assetNames(assetDir)]
      const clientConfig = {
        ...config,
        videoUrl: `${VIDEO_PREFIX}${encodeURIComponent(asset)}`,
        // 桶映射只有一份真相（lib/pools.js），页面侧不再自带素材名单。
        pools: POOLS,
        available,
        videoPrefix: VIDEO_PREFIX,
        stateUrl: STATE_ROUTE,
        stateJsonUrl: STATE_JSON_ROUTE,
        // 页面侧改配置（设置卡片、Ctrl+Alt+M）都往这里 POST，不各自留一份值。
        configUrl: CONFIG_ROUTE,
      }
      const rows = buildInjectionRows({
        clientConfig,
        cssText: readRuntime('bg.css'),
        jsText: readRuntime('bg.js'),
      })
      if (rows.some((row) => typeof row.text === 'string' && row.text.trim() === '')) {
        warn('runtime 产物为空，跳过注入（页面回落到原生外观）')
        return
      }
      table.push(...rows)
    } catch (error) {
      warn(`注入行生成失败，页面将回落到原生外观：${String(error)}`)
    }
  })

  // ── ③ 路由 ──
  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      /** @type {Array<() => void>} */
      const disposers = []

      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: CONFIG_ROUTE,
          handler: async (req, res) => {
            if (req.method === 'POST') {
              if (!isSameOriginRequest(req)) {
                sendJson(res, 403, { ok: false, error: 'cross-origin' })
                return
              }
              const patch = await readJsonBody(req)
              if (patch === undefined) {
                sendJson(res, 400, { ok: false, error: 'bad-json' })
                return
              }
              try {
                const { rejected, config } = writeConfig(dshHome, patch, warn)
                if (rejected) {
                  sendJson(res, 400, { ok: false, error: 'no-valid-key', config })
                  return
                }
                sendJson(res, 200, { ok: true, config })
              } catch (error) {
                warn(`配置写入失败：${String(error)}`)
                sendJson(res, 500, { ok: false, error: 'write-failed' })
              }
              return
            }
            sendJson(res, 200, loadConfig(dshHome))
          },
        }),
      )

      // 状态：JSON 快照（轮询傅底）与 SSE 长连接（首选）。
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: STATE_JSON_ROUTE,
          handler: (req, res) => {
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.setHeader('Cache-Control', 'no-store')
            res.end(JSON.stringify(stateService.snapshot()))
          },
        }),
      )

      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: STATE_ROUTE,
          handler: (req, res) => {
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
            res.setHeader('Cache-Control', 'no-store')
            res.setHeader('Connection', 'keep-alive')
            res.setHeader('X-Accel-Buffering', 'no')
            if (typeof res.flushHeaders === 'function') res.flushHeaders()

            /** @param {object} snapshot */
            const send = (snapshot) => {
              try {
                res.write(`data: ${JSON.stringify(snapshot)}\n\n`)
              } catch {
                /* 页面已关，close 事件会收拾 */
              }
            }

            res.write('retry: 2000\n\n')
            send(stateService.snapshot())
            const off = stateService.subscribe(send)
            const heartbeat = setInterval(() => {
              try {
                res.write(': ping\n\n')
              } catch {
                /* 同上 */
              }
            }, 25000)
            if (typeof heartbeat.unref === 'function') heartbeat.unref()

            let closed = false
            const cleanup = () => {
              if (closed) return
              closed = true
              clearInterval(heartbeat)
              off()
            }
            req.on('close', cleanup)
            res.on('close', cleanup)
          },
        }),
      )

      for (const fileName of assetNames(assetDir)) {
        if (!/\.(webm|mp4|mov|webp|png|jpe?g)$/iu.test(fileName)) continue
        disposers.push(
          child.webServer.register({
            kind: 'exact',
            path: `${VIDEO_PREFIX}${encodeURIComponent(fileName)}`,
            handler: (req, res) => serveAsset(req, res, fileName, assetDir),
          }),
        )
      }

      return () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch {
            /* 卸载期失败不影响其它路由 */
          }
        }
      }
    })
  })
}
