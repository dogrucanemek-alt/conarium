/**
 * One click → list is on the page. Loading is applied before any await.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'public', 'receipts-panel.js'), 'utf8')
const app = fs.readFileSync(path.join(here, '..', 'public', 'app.js'), 'utf8')
const html = fs.readFileSync(path.join(here, '..', 'public', 'index.html'), 'utf8')

assert.match(html, /receipts-panel\.js/, 'panel script must load before app.js')
assert.match(app, /ConariumReceiptsPanel\.showLoading/, 'click path must paint loading before fetch')
assert.doesNotMatch(app, /setTimeout\(\s*loadReceipts/, 'must not hide the race with setTimeout')

function el(init = {}) {
  return {
    hidden: true,
    textContent: '',
    innerHTML: '',
    className: '',
    children: [],
    dataset: {},
    appendChild(c) {
      this.children.push(c)
    },
    ...init,
  }
}

function ui() {
  return {
    chain: el(),
    empty: el(),
    table: el(),
    tbody: el({ hidden: false }),
    detail: el(),
  }
}

function make() {
  return {
    tr: () => el({ dataset: {} }),
    td: () => el(),
    span: () => el(),
    formatTime: (ts) => 'T:' + ts,
  }
}

const sandbox = { window: {}, globalThis: {} }
sandbox.globalThis = sandbox
sandbox.window = sandbox
vm.runInNewContext(src, sandbox)
const panel = sandbox.ConariumReceiptsPanel
assert.ok(panel, 'panel global missing')

const loading = ui()
panel.showLoading(loading)
assert.equal(loading.empty.hidden, false)
assert.equal(loading.empty.textContent, 'Yükleniyor…')
assert.equal(loading.table.hidden, true)

const once = ui()
const state = panel.render(
  once,
  {
    chain: { ok: true, entries: 1 },
    items: [{ id: 'r1', ts: '2026-08-14T10:00:00.000Z', actor: 'svc', tool: 'query', decision: 'allow', maskedCount: 2, seq: 1 }],
    empty: null,
  },
  make(),
)
assert.equal(state, 'list')
assert.equal(once.table.hidden, false)
assert.equal(once.empty.hidden, true)
assert.equal(once.tbody.children.length, 1)
assert.equal(once.chain.textContent, 'zincir sağlam')
assert.ok(once.tbody.children[0].children.some((c) => c.textContent === 'svc'))

const empty = ui()
assert.equal(panel.render(empty, { items: [], empty: 'henüz makbuz yok' }, make()), 'empty')
assert.equal(empty.empty.hidden, false)
assert.match(empty.empty.textContent, /henüz makbuz yok/)
assert.equal(empty.table.hidden, true)

const err = ui()
assert.equal(panel.render(err, { error: 'Makbuz listesi alınamadı (401).' }, make()), 'error')
assert.match(err.empty.textContent, /401/)
assert.equal(err.table.hidden, true)

console.log('PASS  ::  one render() call paints the list; loading is visible before fetch')
process.exit(0)
