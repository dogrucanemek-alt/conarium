/**
 * D4 — one click on Makbuzlar must leave the table filled.
 * jsdom is not a dependency (package forbids adding one). This is a
 * document stub that runs the real public/app.js click path.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const html = fs.readFileSync(path.join(here, '..', 'public', 'index.html'), 'utf8')
const panelSrc = fs.readFileSync(path.join(here, '..', 'public', 'receipts-panel.js'), 'utf8')
const appSrc = fs.readFileSync(path.join(here, '..', 'public', 'app.js'), 'utf8')

function parseAttrs(tag) {
  const attrs = {}
  const re = /([a-zA-Z0-9:-]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g
  let m
  while ((m = re.exec(tag))) {
    if (m[1] === '/') continue
    attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return attrs
}

function makeEl(tag, attrs = {}) {
  const listeners = new Map()
  const el = {
    tagName: String(tag).toUpperCase(),
    attrs: { ...attrs },
    children: [],
    parent: null,
    hidden: attrs.hidden !== undefined,
    className: attrs.class || '',
    id: attrs.id || '',
    textContent: '',
    innerHTML: '',
    value: attrs.value || '',
    dataset: {},
    style: {},
    cookie: '',
    classList: {
      toggle(name, on) {
        const set = new Set(el.className.split(/\s+/).filter(Boolean))
        const should = on === undefined ? !set.has(name) : Boolean(on)
        if (should) set.add(name)
        else set.delete(name)
        el.className = [...set].join(' ')
      },
      add(name) {
        this.toggle(name, true)
      },
      remove(name) {
        this.toggle(name, false)
      },
      contains(name) {
        return el.className.split(/\s+/).includes(name)
      },
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) || []
      list.push(fn)
      listeners.set(type, list)
    },
    dispatchEvent(ev) {
      for (const fn of listeners.get(ev.type) || []) fn(ev)
      return true
    },
    click() {
      this.dispatchEvent({ type: 'click', preventDefault() {}, target: el })
    },
    appendChild(child) {
      child.parent = el
      el.children.push(child)
      return child
    },
    querySelectorAll(sel) {
      return walk(el).filter((n) => match(n, sel))
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null
    },
    getElementById(id) {
      return walk(el).find((n) => n.id === id) || null
    },
  }
  if (attrs['data-tab']) el.dataset.tab = attrs['data-tab']
  if (attrs['data-q']) el.dataset.q = attrs['data-q']
  Object.defineProperty(el, 'textContent', {
    get() {
      return this._text ?? ''
    },
    set(v) {
      this._text = String(v)
      if (v === '') this.children = []
    },
  })
  el._text = ''
  return el
}

function walk(node) {
  const out = [node]
  for (const c of node.children) out.push(...walk(c))
  return out
}

function match(el, sel) {
  if (sel.startsWith('#')) return el.id === sel.slice(1)
  if (sel.startsWith('.')) {
    const parts = sel.split(/\s+/).filter(Boolean)
    if (parts.length === 1) return el.className.split(/\s+/).includes(parts[0].slice(1))
    // descendant: ".pg-samples .chip"
    return false
  }
  if (sel.includes('.')) {
    const [tag, cls] = sel.split('.')
    if (tag && el.tagName !== tag.toUpperCase()) return false
    return el.className.split(/\s+/).includes(cls)
  }
  return el.tagName === sel.toUpperCase()
}

function buildDom(markup) {
  const body = makeEl('body')
  const stack = [body]
  const tokenRe = /<!--[\s\S]*?-->|<[^>]+>|[^<]+/g
  let tok
  while ((tok = tokenRe.exec(markup))) {
    const raw = tok[0]
    if (raw.startsWith('<!--') || raw.startsWith('<!')) continue
    if (raw.startsWith('</')) {
      if (stack.length > 1) stack.pop()
      continue
    }
    if (raw.startsWith('<')) {
      const self = /\/\s*>$/.test(raw)
      const name = raw.match(/^<\/?([a-zA-Z0-9-]+)/)?.[1]
      if (!name || name === 'html' || name === 'head' || name === 'meta' || name === 'link' || name === 'title' || name === 'script') {
        continue
      }
      const el = makeEl(name, parseAttrs(raw))
      stack[stack.length - 1].appendChild(el)
      if (!self && !/^(br|img|input|meta|link)$/i.test(name)) stack.push(el)
      continue
    }
    const text = raw.trim()
    if (text) stack[stack.length - 1].textContent += text
  }
  return body
}

const document = buildDom(html)
const qsa = document.querySelectorAll.bind(document)
document.querySelectorAll = (sel) => {
  if (sel === '.pg-samples .chip') {
    return walk(document).filter((n) => n.className.split(/\s+/).includes('chip'))
  }
  if (sel === '.receipt-table-row') {
    return walk(document).filter((n) => n.className.split(/\s+/).includes('receipt-table-row'))
  }
  return qsa(sel)
}
document.querySelector = (sel) => document.querySelectorAll(sel)[0] || null
document.createElement = (tag) => makeEl(tag)
document.cookie = ''

const receiptsPayload = {
  chain: { ok: true, entries: 2 },
  items: [
    { id: 'r1', ts: '2026-08-14T10:00:00.000Z', actor: 'svc', tool: 'query', decision: 'allow', maskedCount: 2, seq: 1 },
    { id: 'r2', ts: '2026-08-14T10:00:01.000Z', actor: 'svc', tool: 'query', decision: 'partial', maskedCount: 1, seq: 2 },
  ],
}

const fetchCalls = []
async function fakeFetch(url) {
  fetchCalls.push(String(url))
  const pathOnly = String(url).split('?')[0]
  if (pathOnly === '/api/receipts') {
    return { ok: true, status: 200, json: async () => receiptsPayload }
  }
  return { ok: true, status: 200, json: async () => (pathOnly === '/api/audit' || pathOnly === '/api/connectors' ? [] : {}) }
}

const ctx = {
  console,
  setTimeout,
  setInterval: () => 0,
  clearInterval() {},
  Date,
  JSON,
  encodeURIComponent,
  document,
  location: { search: '' },
  sessionStorage: { getItem: () => '', setItem() {} },
  fetch: fakeFetch,
  URLSearchParams,
  addEventListener() {},
}
ctx.window = ctx
ctx.globalThis = ctx
ctx.document = document

vm.runInNewContext(panelSrc, ctx)
vm.runInNewContext(appSrc, ctx)

document.dispatchEvent({ type: 'DOMContentLoaded' })
await new Promise((r) => setImmediate(r))
await new Promise((r) => setImmediate(r))

const tab = walk(document).find((n) => n.dataset?.tab === 'receipts')
assert.ok(tab, 'Makbuzlar nav item missing')
const tbodyBefore = document.getElementById('receipt-body')
assert.ok(tbodyBefore, 'receipt-body missing')

tab.click()
await new Promise((r) => setImmediate(r))
await new Promise((r) => setImmediate(r))
await Promise.resolve()
await Promise.resolve()

const tbody = document.getElementById('receipt-body')
const rows = tbody.children.filter((c) => c.tagName === 'TR')
assert.ok(rows.length >= 2, `first click left the table empty (rows=${rows.length}, fetches=${fetchCalls.join(',')})`)
assert.equal(document.getElementById('receipt-table').hidden, false)
assert.equal(document.getElementById('receipt-empty').hidden, true)
assert.ok(fetchCalls.some((u) => u.startsWith('/api/receipts')))

console.log('PASS  ::  D4 one click on Makbuzlar fills the table')
