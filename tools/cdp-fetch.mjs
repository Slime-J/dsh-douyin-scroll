#!/usr/bin/env node
/**
 * tools/cdp-fetch.mjs —— 签名器挂了时的**兜底拉接口**：在已登录的无头 Chrome 里发
 * ============================================================================
 * 2026-10-26 实测出的三个真相（Issue #2 作者思路的正确姿势）：
 *   ① 空首页（douyin.com/）上页面签名 SDK **不启动** —— fetch/XHR 都没有 a_bogus，
 *      抖音对没签名的请求是「200 软拒 + 空 body」，不是 403；
 *   ② **视频页**（/video/<id>）上 SDK 才活了：bdms 接管 XMLHttpRequest.prototype.open，
 *      页面里发 XHR 自动补 a_bogus，status_code=0 有真 body；
 *   ③ 要用 **XHR**，不能用 fetch（bdms 只挂钩 XHR）。
 *
 * 所以本脚本：
 *   A. ensureChrome 拿端口 → 找视频页 tab
 *   B. 没有就把现有 tab 导航过去（SPA 路由；期间连接会断，分两段连）
 *   C. 轮询等「XHR 已被接管」（openIsPatched，~20s）
 *   D. 页面上下文 XHR → stdout 只吐响应体（日志走 stderr）
 *
 * 用法：
 *   node tools/cdp-fetch.mjs --path "/aweme/v1/web/comment/list/?aweme_id=…"
 *   node tools/cdp-fetch.mjs --url  "https://www.douyin.com/aweme/v1/web/…"
 * ============================================================================
 */
import { ensureChrome } from '../lib/chrome.mjs'

const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : ''
}

const pathOrUrl = argOf('--path') || argOf('--url') || ''
if (!pathOrUrl) {
  console.error('用法：node tools/cdp-fetch.mjs --path "/aweme/v1/web/..."')
  process.exit(2)
}
const abs = pathOrUrl.startsWith('http')
  ? pathOrUrl
  : 'https://www.douyin.com' + (pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl)

const log = (s) => console.error('[cdp-fetch] ' + s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 2026-11-09 CEO-20261109-02：所有网络等待都要有上限，否则浏览器不响应就永久挂着
// （实测卡死 9 小时零产出、白占 4GB 内存，连带全量测试被杀）。
const argNum = (k, d) => {
  const v = Number(argOf(k))
  return Number.isFinite(v) && v > 0 ? v : d
}
const FETCH_MS = argNum('--fetch-timeout', 15000)   // /json/list 与 WS 单次调用
const CDP_MS = argNum('--cdp-timeout', 20000)       // 单次 CDP 调用（Runtime.evaluate 等）
const TOTAL_MS = argNum('--timeout', 120000)        // 整体看门狗

const watchdog = setTimeout(() => {
  log(`整体超时 ${TOTAL_MS}ms，强制退出（防挂死）`)
  process.exit(2)
}, TOTAL_MS)
watchdog.unref?.()

/** 带超时的 fetch：CDP 端口不响应时也要能退出。 */
async function fetchJson(url, ms) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    const res = await fetch(url, { signal: ac.signal })
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 连一个 tab 的 CDP，返回 { send, ev, close } */
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pend = new Map()
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`连不上 CDP WebSocket（超时 ${FETCH_MS}ms）`)), FETCH_MS)
    ws.addEventListener('open', () => { clearTimeout(timer); res() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('连不上 CDP WebSocket')) }, { once: true })
  })
  ws.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data) } catch { return }
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  })
  // 2026-11-09：与 cdp.mjs 同一段复制代码，同样必须带超时，否则只修一半。
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id
    const timer = setTimeout(() => {
      pend.delete(mid)
      try { ws.close() } catch { /* 已关 */ }
      log(`CDP 调用超时 ${CDP_MS}ms：${method}（浏览器无响应）`)
      process.exit(1)
    }, CDP_MS)
    pend.set(mid, {
      res: (v) => { clearTimeout(timer); res(v) },
      rej: (e) => { clearTimeout(timer); rej(e) },
    })
    try {
      ws.send(JSON.stringify({ id: mid, method, params }))
    } catch (e) {
      clearTimeout(timer); pend.delete(mid); rej(e)
    }
  })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) throw new Error('页面里抛错: ' + JSON.stringify(r.exceptionDetails).slice(0, 240))
    return r.result?.value
  }
  return { send, ev, close: () => { try { ws.close() } catch { /* 已关 */ } } }
}

const listTargets = async (port) => (await fetchJson(`http://127.0.0.1:${port}/json/list`, FETCH_MS))
  .filter((t) => t.type === 'page')

/** 页面 SDK 是否已接管 XHR（app 起来的标志） */
const appReadyExpr = `(() => {
  try {
    const s = XMLHttpRequest.prototype.open.toString()
    return !s.includes('[native code]') && typeof window.bdms === 'object'
  } catch (e) { return false }
})()`

/** 页面上下文 XHR（bdms 会自动补 a_bogus） */
const xhrExpr = (url) => `(async () => {
  return await new Promise((resolve) => {
    try {
      const x = new XMLHttpRequest()
      x.open('GET', ${JSON.stringify(url)}, true)
      x.timeout = 20000
      x.onreadystatechange = () => {
        if (x.readyState === 4) resolve({ status: x.status, body: x.responseText })
      }
      x.onerror = () => resolve({ status: 0, body: '' })
      x.ontimeout = () => resolve({ status: 0, body: '' })
      x.send()
    } catch (e) { resolve({ status: 0, body: '' }) }
  })
})()`

try {
  const { port } = await ensureChrome()
  const mId = /aweme_id=(\d+)/.exec(abs)?.[1] || ''
  const videoUrl = mId ? `https://www.douyin.com/video/${mId}` : 'https://www.douyin.com/'

  // A. 找视频页 tab（SPA 路由页也算：/video/ /note/ /search/ 都带 SDK）
  let targets = await listTargets(port)
  let video = targets.find((t) => /\/(video|note|search)\//.test(t.url || ''))

  // B. 没有 → 拿任意 douyin tab 导航过去（期间 WS 会断，先发导航再重连）
  if (!video) {
    const anyTab = targets.find((t) => String(t.url).includes('douyin')) || targets[0]
    if (!anyTab) { log('Chrome 里一个 page tab 都没有'); process.exit(1) }
    log(`没有视频页 tab，把 ${String(anyTab.url).slice(0, 60)} 导航到视频页…`)
    let c = await connect(anyTab)
    await c.ev(`location.href = ${JSON.stringify(videoUrl)}`).catch(() => { /* 导航中断连接属正常 */ })
    c.close()
  }

  // C. 轮询：等视频页 tab 出现 + XHR 被接管
  let page = null
  for (let i = 0; i < 40; i++) {
    await sleep(1000)
    try {
      targets = await listTargets(port)
      video = targets.find((t) => /\/(video|note|search)\//.test(t.url || ''))
      if (!video) continue
      const c = await connect(video)
      const ok = await c.ev(appReadyExpr).catch(() => false)
      if (ok) { page = { tab: video, c }; break }
      c.close()
    } catch { /* 导航中，接着等 */ }
  }
  if (!page) { log('等了 40s，页面签名 SDK 还是没就绪（XHR 未被接管）'); process.exit(1) }
  log(`页面就绪：${String(page.tab.url).slice(0, 70)}`)

  // D. XHR 拉数据
  const t0 = Date.now()
  const r = await page.c.ev(xhrExpr(abs))
  page.c.close()
  if (!r || !r.body) { log(`HTTP ${r?.status ?? '?'} 空 body（风控软拒或页面态丢了）`); process.exit(1) }
  log(`HTTP ${r.status}，${r.body.length} 字节，${Date.now() - t0}ms`)
  process.stdout.write(r.body)
  process.exit(r.status === 200 ? 0 : 1)
} catch (e) {
  log('失败：' + String(e?.message ?? e).slice(0, 300))
  process.exit(1)
}
