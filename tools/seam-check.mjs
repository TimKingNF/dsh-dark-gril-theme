#!/usr/bin/env node
/**
 * tools/seam-check.mjs —— 接缝 / 右栏三项数字检查（一次性，可留用）。
 *
 * 三个问题，对应三条判据：
 *   a) 接缝右侧 1px 起、向右 --band px（默认 40）的竖直条带里，有没有"随时间变化"的像素。
 *      右栏里出现的任何变化都只能来自视频 —— 所以这一项必须是 0。
 *      需要两张不同时刻的截图才能比。
 *   b) 跨越 seam ±40px 的若干行的一维亮度剖面，报最大一阶差分（0–255）。
 *      硬边 = 一步大跳；自然收边 = 把亮度差摊到几十像素上，单步很小。
 *   c) 底部 y=95% 那一行，从 seam-200 到图右缘的亮度剖面：报最大值、位置，
 *      以及是否单调不增（整段 / 峰值之后）。
 *
 * 只用 node 内置模块（node:zlib 解 PNG），不装依赖。只吃 PNG。
 *
 * 用法：
 *   node tools/seam-check.mjs --image shot.png --seam 1408
 *   node tools/seam-check.mjs --image t0.png --image2 t1.png --seam 1408
 *   node tools/seam-check.mjs --image shot.png --seam 2816 --band 40 --json
 *
 * --seam 用**截图自身的像素坐标**。截图为 DPR=2 时是 CSS 坐标 ×2
 * （例如 CSS 里 videoRight=1408 → 截图里 --seam 2816）。
 */

import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/**
 * 解 PNG：只支持非隔行、8/16 bit、灰度/RGB/调色板/灰度+alpha/RGBA。
 * 返回 8-bit 样本（调色板展开成 RGB），并提供 luma(x,y)。
 *
 * @param {string} file
 */
function readPng(file) {
  const buf = readFileSync(file)
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${file} 不是 PNG（这个工具只解 PNG，不解 JPEG）`)
  }

  let pos = 8
  let header = null
  let palette = null
  const idat = []

  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + length)
    pos += 12 + length
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      }
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }

  if (!header) throw new Error(`${file} 缺少 IHDR`)
  if (!(header.colorType in CHANNELS)) {
    throw new Error(`${file} 的 colorType=${header.colorType} 不支持`)
  }
  if (header.interlace !== 0) throw new Error(`${file} 是隔行 PNG，先另存为非隔行`)
  if (header.bitDepth !== 8 && header.bitDepth !== 16) {
    throw new Error(`${file} 的 bitDepth=${header.bitDepth} 不支持（只支持 8/16）`)
  }
  if (header.colorType === 3 && (!palette || header.bitDepth !== 8)) {
    throw new Error(`${file} 的调色板 PNG 需要 8-bit PLTE`)
  }

  const { width, height, bitDepth, colorType } = header
  const channels = CHANNELS[colorType]
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8))
  const stride = Math.ceil((width * channels * bitDepth) / 8)
  const raw = inflateSync(Buffer.concat(idat))
  if (raw.length < (stride + 1) * height) {
    throw new Error(`${file} 的 IDAT 长度不足（${raw.length} < ${(stride + 1) * height}）`)
  }

  // 反过滤：Sub/Up/Average/Paeth 四种预测逐行还原。
  const unfiltered = Buffer.alloc(stride * height)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = unfiltered.subarray(y * stride, (y + 1) * stride)
    for (let i = 0; i < stride; i += 1) {
      const left = i >= bpp ? out[i - bpp] : 0
      const up = prev[i]
      const upLeft = i >= bpp ? prev[i - bpp] : 0
      const x = line[i]
      let value
      switch (filter) {
        case 0:
          value = x
          break
        case 1:
          value = x + left
          break
        case 2:
          value = x + up
          break
        case 3:
          value = x + ((left + up) >> 1)
          break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          value = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
          break
        }
        default:
          throw new Error(`${file} 第 ${y} 行的过滤类型 ${filter} 非法`)
      }
      out[i] = value & 0xff
    }
    prev = out
  }

  // 统一成 8-bit 样本：16-bit 取高字节，调色板展开成 RGB。
  const step = bitDepth === 16 ? 2 : 1
  const sample = (y, i) => unfiltered[(y * stride + i) * step]

  let rgb
  if (colorType === 3) {
    rgb = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = sample(y, x)
        rgb[(y * width + x) * 3] = palette[index * 3]
        rgb[(y * width + x) * 3 + 1] = palette[index * 3 + 1]
        rgb[(y * width + x) * 3 + 2] = palette[index * 3 + 2]
      }
    }
    rgb.channels = 3
    rgb.width = width
  } else {
    rgb = Buffer.alloc(width * height * channels)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width * channels; x += 1) rgb[y * width * channels + x] = sample(y, x)
    }
    rgb.channels = channels
    rgb.width = width
  }

  const cx = rgb.channels
  const plane = rgb
  /** 取 RGB（灰度复制三份，带 alpha 的忽略 alpha）。 */
  function at(x, y) {
    const base = (y * width + x) * cx
    if (cx >= 3) return [plane[base], plane[base + 1], plane[base + 2]]
    return [plane[base], plane[base], plane[base]]
  }
  /** 亮度 0–255（Rec.709 系数，和 CSS 的亮度感知一致）。 */
  function luma(x, y) {
    const [r, g, b] = at(x, y)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  return { file, width, height, at, luma }
}

/** 解析 `--key value` 与 `--flag`。 */
function parseArgs(argv) {
  const options = {
    image: null,
    image2: null,
    seam: null,
    band: 40,
    rows: [20, 40, 60, 80],
    bottom: 95,
    tol: 2,
    slack: 1,
    json: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    switch (key) {
      case '--image':
        options.image = value
        i += 1
        break
      case '--image2':
        options.image2 = value
        i += 1
        break
      case '--seam':
        options.seam = Number(value)
        i += 1
        break
      case '--band':
        options.band = Number(value)
        i += 1
        break
      case '--rows':
        options.rows = String(value)
          .split(',')
          .map((part) => Number(part.trim()))
          .filter((n) => Number.isFinite(n))
        i += 1
        break
      case '--bottom':
        options.bottom = Number(value)
        i += 1
        break
      case '--tol':
        options.tol = Number(value)
        i += 1
        break
      case '--slack':
        options.slack = Number(value)
        i += 1
        break
      case '--json':
        options.json = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`不认识的参数 ${key}（--help 看用法）`)
    }
  }
  return options
}

const HELP = `用法：
  node tools/seam-check.mjs --image shot.png --seam 1408
  node tools/seam-check.mjs --image t0.png --image2 t1.png --seam 1408

参数：
  --image      第一张截图（PNG）
  --image2     第二张、不同时刻的截图；给了才做 (a) 动态检查
  --seam       videoRight 在截图里的像素 x
  --band       接缝右侧检查条带宽度，默认 40
  --rows       跨接缝取剖面的行（高度百分比），默认 20,40,60,80
  --bottom     底部光源剖面的行（高度百分比），默认 95
  --tol        动态检查的单像素容差（0–255），默认 2
  --slack      单调性检查允许的回升（0–255），默认 1
  --json       输出 JSON
`

/** (a) 接缝右侧条带里的时间变化。 */
function checkMotion(a, b, seam, band, tol) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`两张截图尺寸不同：${a.width}x${a.height} vs ${b.width}x${b.height}`)
  }
  const x0 = seam + 1
  const x1 = Math.min(a.width - 1, seam + band)
  const columns = []
  let compared = 0
  let changed = 0
  let maxDiff = 0
  let worst = null
  for (let x = x0; x <= x1; x += 1) {
    let columnChanged = 0
    for (let y = 0; y < a.height; y += 1) {
      const pa = a.at(x, y)
      const pb = b.at(x, y)
      const diff = Math.max(
        Math.abs(pa[0] - pb[0]),
        Math.abs(pa[1] - pb[1]),
        Math.abs(pa[2] - pb[2]),
      )
      compared += 1
      if (diff > tol) {
        changed += 1
        columnChanged += 1
      }
      if (diff > maxDiff) {
        maxDiff = diff
        worst = { x, y, a: pa, b: pb }
      }
    }
    if (columnChanged > 0) columns.push({ x, changed: columnChanged })
  }
  return {
    band: [x0, x1],
    compared,
    changed,
    fraction: compared === 0 ? 0 : changed / compared,
    maxDiff,
    worst,
    movingColumns: columns.length,
    columns,
    pass: changed === 0,
  }
}

/** (b) 跨接缝若干行的一维亮度剖面 + 最大一阶差分。 */
function checkRows(image, seam, rows, half = 40) {
  const from = Math.max(0, seam - half)
  const to = Math.min(image.width - 1, seam + half)
  const result = []
  for (const pct of rows) {
    const y = Math.min(image.height - 1, Math.max(0, Math.round((pct / 100) * (image.height - 1))))
    const profile = []
    for (let x = from; x <= to; x += 1) profile.push({ x, luma: image.luma(x, y) })
    let maxStep = 0
    let at = null
    for (let i = 1; i < profile.length; i += 1) {
      const step = Math.abs(profile[i].luma - profile[i - 1].luma)
      if (step > maxStep) {
        maxStep = step
        at = { x: profile[i].x, before: profile[i - 1].luma, after: profile[i].luma }
      }
    }
    const left = image.luma(Math.max(0, seam - 1), y)
    const right = image.luma(Math.min(image.width - 1, seam), y)
    result.push({
      y,
      percent: pct,
      from,
      to,
      maxStep,
      at,
      seamLeft: left,
      seamRight: right,
      seamStep: Math.abs(right - left),
    })
  }
  return result
}

/** (c) 底部一行从 seam-lead 到图右缘的亮度剖面。 */
function checkBottom(image, seam, percent, lead = 200, slack = 1) {
  const y = Math.min(image.height - 1, Math.max(0, Math.round((percent / 100) * (image.height - 1))))
  const from = Math.max(0, seam - lead)
  const to = image.width - 1
  const samples = []
  for (let x = from; x <= to; x += 1) samples.push({ x, luma: image.luma(x, y) })

  let peak = samples[0]
  for (const sample of samples) if (sample.luma > peak.luma) peak = sample

  let monotonic = true
  let worstRise = 0
  for (let i = 1; i < samples.length; i += 1) {
    const delta = samples[i].luma - samples[i - 1].luma
    if (delta > 0) {
      monotonic = false
      if (delta > worstRise) worstRise = delta
    }
  }

  const peakIndex = samples.indexOf(peak)
  let afterPeak = true
  let afterPeakWorstRise = 0
  for (let i = peakIndex + 1; i < samples.length; i += 1) {
    const delta = samples[i].luma - samples[i - 1].luma
    if (delta > slack) {
      afterPeak = false
      if (delta > afterPeakWorstRise) afterPeakWorstRise = delta
    }
  }

  return {
    y,
    percent,
    from,
    to,
    max: peak.luma,
    maxX: peak.x,
    maxPercent: ((peak.x - from) / Math.max(1, to - from)) * 100,
    min: samples.reduce((low, s) => (s.luma < low ? s.luma : low), Infinity),
    monotonicNonIncreasing: monotonic,
    worstRise,
    afterPeakMonotonic: afterPeak,
    afterPeakWorstRise,
    samples: samples.filter((_, i) => i % Math.max(1, Math.round(samples.length / 21)) === 0
      || i === samples.length - 1),
  }
}

/** 16 项等距抽样，给肉眼看形状。 */
const spark = (values) => {
  const blocks = ' .:-=+*#%@'
  const low = Math.min(...values)
  const high = Math.max(...values)
  const span = Math.max(1, high - low)
  return values
    .map((value) => blocks[Math.min(9, Math.round(((value - low) / span) * 9))])
    .join('')
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help || !options.image) {
    process.stdout.write(HELP)
    if (!options.help) process.exitCode = 2
    return
  }
  if (!Number.isFinite(options.seam)) throw new Error('必须给 --seam <x>')

  const first = readPng(options.image)
  if (options.seam < 0 || options.seam >= first.width) {
    throw new Error(`--seam=${options.seam} 超出图像宽度 ${first.width}`)
  }
  if (options.seam + options.band >= first.width) {
    console.warn(`[warn] --seam+--band = ${options.seam + options.band} 已到图右缘 ${first.width}，条带会被截短`)
  }

  const report = {
    image: { file: first.file, width: first.width, height: first.height },
    seam: options.seam,
    band: options.band,
    motion: null,
    rows: null,
    bottom: null,
  }

  if (options.image2) {
    const second = readPng(options.image2)
    report.motion = checkMotion(first, second, options.seam, options.band, options.tol)
  }
  report.rows = checkRows(first, options.seam, options.rows)
  report.bottom = checkBottom(first, options.seam, options.bottom, 200, options.slack)

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }

  const x1 = Math.round(options.seam + options.band)
  const out = []
  out.push(`图像 ${report.image.file}  ${report.image.width}x${report.image.height}  seam=${report.seam}`)
  out.push('')
  out.push(`(a) 接缝右侧 [${options.seam + 1}, ${x1}] 的动态像素`)
  if (!report.motion) {
    out.push('    跳过：只给了一张图，需要 --image2 另一时刻的截图才能比.')
  } else {
    const motion = report.motion
    out.push(`    像素 ${motion.compared}，变化 ${motion.changed}（容差 ${options.tol}），占比 ${(motion.fraction * 100).toFixed(3)}%`)
    out.push(`    最大单像素差 ${motion.maxDiff}${motion.worst ? ` @ x=${motion.worst.x} y=${motion.worst.y}` : ''}`)
    out.push(`    有变化的列 ${motion.movingColumns} 列`)
    out.push(`    判定：${motion.pass ? 'PASS 右栏无动态像素（不含视频）' : 'FAIL 右栏里还有东西在动，多半是视频在透'}`)
  }
  out.push('')
  out.push('(b) 跨接缝 ±40px 的亮度剖面（0–255）')
  out.push('    y%    接缝左   接缝右   接缝一步   全段最大一步')
  for (const row of report.rows) {
    out.push(
      `    ${String(row.percent).padStart(3)}   ${row.seamLeft.toFixed(1).padStart(7)}  ${row.seamRight.toFixed(1).padStart(7)}  ${row.seamStep.toFixed(1).padStart(9)}  ${row.maxStep.toFixed(1).padStart(9)}${row.at ? ` @x=${row.at.x}` : ''}`,
    )
  }
  const worstRow = report.rows.reduce((worst, row) => (row.maxStep > worst.maxStep ? row : worst))
  const worstSeam = report.rows.reduce((worst, row) => (row.seamStep > worst.seamStep ? row : worst))
  out.push(`    全段最大一阶差分 ${worstRow.maxStep.toFixed(1)}（y=${worstRow.percent}% @x=${worstRow.at ? worstRow.at.x : '-'}）`)
  out.push('')
  const bottom = report.bottom
  out.push(`(c) y=${bottom.percent}% 从 x=${bottom.from}（seam-200）到 x=${bottom.to} 的亮度`)
  out.push(`    最大 ${bottom.max.toFixed(1)} @ x=${bottom.maxX}（距左端 ${bottom.maxPercent.toFixed(0)}%），最小 ${bottom.min.toFixed(1)}`)
  out.push(`    整段单调不增：${bottom.monotonicNonIncreasing ? '是' : `否（最大回升 ${bottom.worstRise.toFixed(1)}）`}`)
  out.push('      ↑ 光源的圆心在 seam 左侧一小段（box 的 8%），所以"整段不增"本来就不成立，看下一行。')
  out.push(`    峰值之后单调不增：${bottom.afterPeakMonotonic ? '是' : `否（回升 ${bottom.afterPeakWorstRise.toFixed(1)}）`}`)
  out.push(`    形状 ${spark(bottom.samples.map((s) => s.luma))}  （左→右）`)
  out.push('')
  out.push('—— 三个数 ——')
  out.push(
    `  (a) 右栏动态像素：${report.motion ? (report.motion.pass ? `0（PASS，${report.motion.compared} 像素全等）` : `FAIL ${report.motion.changed}/${report.motion.compared} 变了，maxΔ=${report.motion.maxDiff}`) : '未测（需 --image2）'}`,
  )
  out.push(`  (b) 接缝 1px 最大跳变：${worstSeam.seamStep.toFixed(1)}（y=${worstSeam.percent}%）；±40px 内最大一阶差分：${worstRow.maxStep.toFixed(1)}`)
  out.push(
    `  (c) 底部峰值 ${bottom.max.toFixed(1)} @x=${bottom.maxX}；峰值之后${bottom.afterPeakMonotonic ? '单调不增（一盏灯）' : `有回升 ${bottom.afterPeakWorstRise.toFixed(1)}（读成第二块板）`}`,
  )
  process.stdout.write(`${out.join('\n')}\n`)
}

try {
  main()
} catch (error) {
  console.error(`[seam-check] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
