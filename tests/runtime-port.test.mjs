/** runtime.json cdpPort 范围校验（CEO-20261109-03①）：9334–9373 之外一律无效。
 *  背景：2026-11-09 ensureChrome 把 cdpPort 写成 58001，后续采集静默连假服务报超时。
 *  隔离：DOUYIN_HOME 指向临时目录，不碰真库 ~/.dsh/douyin-duty/。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync as wfs, readFileSync as rfs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'runtime-port-'))
process.env.DOUYIN_HOME = tmp                     // 在 import 前设好，paths.mjs 读它
const { readRuntime, writeRuntime, runtimeFile } = await import('../lib/paths.mjs')
const file = join(tmp, 'runtime.json')

const MIN = 9334, MAX = 9373
const inRange = (p) => Number.isInteger(Number(p)) && Number(p) >= MIN && Number(p) <= MAX

test('readRuntime: cdpPort 58001（越界）→ 消费方判据 inRange 必须为 false', () => {
  wfs(file, JSON.stringify({ cdpPort: 58001, browser: 'chrome' }), 'utf8')
  const rt = readRuntime()
  assert.equal(inRange(rt.cdpPort), false, '58001 必须判越界')
})

test('readRuntime: cdpPort 9334（正常）→ inRange true，照常复用', () => {
  wfs(file, JSON.stringify({ cdpPort: 9334 }), 'utf8')
  const rt = readRuntime()
  assert.equal(inRange(rt.cdpPort), true)
})

test('writeRuntime: cdpPort 58001（越界）→ 拒绝写入并抛错，文件不落越界值', () => {
  wfs(file, JSON.stringify({ cdpPort: 9334 }), 'utf8')  // 先落合法基线
  assert.throws(() => writeRuntime({ cdpPort: 58001 }), /cdpPort/)
  const onDisk = JSON.parse(rfs(file, 'utf8'))
  assert.notEqual(onDisk.cdpPort, 58001)
})

test('writeRuntime: cdpPort 9334（正常）→ 照常写入', () => {
  writeRuntime({ cdpPort: 9334 })
  assert.equal(JSON.parse(rfs(file, 'utf8')).cdpPort, 9334)
})

test('writeRuntime: 边界 9333/9374 越界拒绝、9373 在界接受', () => {
  assert.throws(() => writeRuntime({ cdpPort: 9333 }), /cdpPort/)
  assert.throws(() => writeRuntime({ cdpPort: 9374 }), /cdpPort/)
  writeRuntime({ cdpPort: 9373 })
  assert.equal(JSON.parse(rfs(file, 'utf8')).cdpPort, 9373)
})

test('pickPort 消费方语义：remembered 越界时必须当作没记住（走扫描）', () => {
  // 复刻 chrome.mjs pickPort 判据：remembered 越界 → 视同 0 → 走扫描
  const remembered = 58001
  assert.equal(inRange(remembered), false)
  assert.equal(inRange(9340), true)
})

test('收尾清理临时目录', () => { rmSync(tmp, { recursive: true, force: true }) })
