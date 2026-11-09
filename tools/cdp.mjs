#!/usr/bin/env node
/**
 * tools/cdp.mjs —— 直接跟 bb-browser 那个 Chrome 说 CDP，绕开所有引号转义问题
 *
 * 用法：
 *   node tools/cdp.mjs <js文件> [--port 9222] [--tab <tabId>]
 *
 * 为什么不用 `bb-browser eval`：PowerShell 会把 JS 里的双引号吃掉，
 * 那个 Chrome 里跑的是**已经登录的抖音页面**，页面自己的 fetch 会被 secsdk 补上签名 ——
 * 只有这样才可能把写接口打穿。
 */
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const file = argv.find((a) => !a.startsWith('--'))
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const PORT = argOf('--port', '9222')
const TAB = argOf('--tab', '')
// 2026-11-09 CEO-20261109-02：单次 CDP 调用的超时（毫秒）。浏览器不响应时
// 旧实现会永久挂着 —— 实测卡死 9 小时零产出、白占 4GB 内存。
const TIMEOUT_MS = Math.max(100, Number(argOf('--timeout', '20000')) || 20000)
// 整体看门狗：从启动起算，超过就自杀，防在别处挂住（例如 fetch /json/list 卡住）。
const WATCHDOG_MS = Math.max(1000, Number(argOf('--watchdog', '90000')) || 90000)

const die = (code, msg) => {
  if (msg) console.error(msg)
  process.exit(code)
}

// 看门狗用 unref 的定时器：正常路径跑完会主动 process.exit，不会被它拖住。
const watchdog = setTimeout(() => {
  die(2, `⏱ 整体超时 ${WATCHDOG_MS}ms，强制退出（防挂死）`)
}, WATCHDOG_MS)
watchdog.unref?.()

const expr = readFileSync(file, 'utf8')

/** 带超时的 fetch：CDP 端口不响应时也要能退出，不能永久 await。 */
const fetchJson = async (url, ms) => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    const res = await fetch(url, { signal: ac.signal })
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

let list
try {
  list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`, TIMEOUT_MS)
} catch (e) {
  die(1, `❌ 连不上 CDP 端口 ${PORT}（${e?.name === 'AbortError' ? `超时 ${TIMEOUT_MS}ms` : e?.message ?? e}）`)
}
const pages = list.filter((t) => t.type === 'page')
const target = TAB ? pages.find((p) => p.id.includes(TAB) || p.url.includes(TAB)) : pages.find((p) => p.url.includes('douyin')) || pages[0]
if (!target) { console.error('没有可用的 page target'); process.exit(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id
  // 2026-11-09：ws.send 之后浏览器不响应 → 旧实现永挂。现在超时就 reject + 清理 +
  // 关 WS + 非 0 退出，绝不留在后台占内存。
  const timer = setTimeout(() => {
    pending.delete(mid)
    try { ws.close() } catch { /* 已关 */ }
    die(1, `❌ CDP 调用超时 ${TIMEOUT_MS}ms：${method}（浏览器无响应）`)
  }, TIMEOUT_MS)
  pending.set(mid, {
    resolve: (v) => { clearTimeout(timer); resolve(v) },
    reject: (e) => { clearTimeout(timer); reject(e) },
  })
  try {
    ws.send(JSON.stringify({ id: mid, method, params }))
  } catch (e) {
    clearTimeout(timer)
    pending.delete(mid)
    reject(e)
  }
})

ws.addEventListener('message', (ev) => {
  let msg
  try { msg = JSON.parse(ev.data) } catch { return }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
})

ws.addEventListener('open', async () => {
  clearTimeout(openTimer)
  try {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (r.exceptionDetails) {
      console.log('❌ 页面里抛错：', JSON.stringify(r.exceptionDetails).slice(0, 600))
      process.exitCode = 1
    } else {
      const v = r.result?.value
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
      process.exitCode = 0
    }
  } catch (e) {
    console.error('CDP 失败：', e?.message ?? e)
    process.exitCode = 1
  } finally {
    try { ws.close() } catch { /* 已关 */ }
    process.exit(process.exitCode ?? 0)
  }
})

ws.addEventListener('error', (e) => {
  console.error('❌ WS 错误：', e?.message ?? e)
  die(1, '')
})

// 连接本身也不能永久等：WS 握手卡住时同样要退出。握手成功就清掉，
// 否则它会和 send() 的超时同时到点、抢先把错误报成「连不上 WS」。
const openTimer = setTimeout(() => {
  die(1, `❌ 连不上 CDP WebSocket（超时 ${TIMEOUT_MS}ms）`)
}, TIMEOUT_MS)
openTimer.unref?.()
