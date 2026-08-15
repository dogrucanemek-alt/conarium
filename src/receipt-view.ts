/**
 * Receipt → HTML. Presentation only: no files, no network, no schema change.
 * Demo /proof and the console tab both call this. A second copy will drift.
 */
import type { Receipt, ReceiptChainCheck, PolicyDecision } from './receipt.js'

export function wantsReceiptHtml(accept: string | undefined, format?: string | null): boolean {
  const fmt = (format || '').trim().toLowerCase()
  if (fmt === 'json') return false
  if (fmt === 'html') return true
  return (accept || '').toLowerCase().includes('text/html')
}

export function serializeReceiptJson(value: unknown): string {
  return JSON.stringify(value)
}

export interface ReceiptViewOperation {
  request: string
  policy: PolicyDecision
  rowsReturned?: number | null
  maskedCount?: number | null
  sample?: string
  reason?: string
}

export type AnchorDisplay = 'pending' | 'unverified' | 'verified'

export interface ReceiptViewAnchor {
  log?: string
  state: 'pending' | 'bitcoin'
  ref?: string
  /** What the page may print. Absent + claimed bitcoin → unverified. */
  display?: AnchorDisplay
}

/** Presentation document. Not a receipt field and not a LiveProof schema. */
export interface ReceiptView {
  title: string
  generatedAt: string
  limitations: string[]
  claim?: string
  operations: ReceiptViewOperation[]
  chain: { seq: number | string; entries?: number | string; head: string }
  chainIntegrity?: ReceiptChainCheck
  signature: { alg: string; keyId: string; meaning: boolean } | null
  signatureAbsentNote?: string
  publicKey: string | null
  verify: string
  anchor: ReceiptViewAnchor | null
  jsonHref?: string
}

/** Structural input for the demo /proof payload. Lives here so nexus does not keep a renderer. */
export interface ProofLike {
  generatedAt: string
  engine: { name: string; version: string }
  operations: ReceiptViewOperation[]
  chain: { seq: number; head: string; entries: number }
  signature: { alg: string; keyId: string; value?: string } | null
  publicKey: string | null
  signatureMeaning: boolean
  anchor: ReceiptViewAnchor | null
  /** Set only after sidecar OTS verification. */
  anchorVerified?: boolean
  verify: string
  claim: string
  limitations: string[]
}

export const RECEIPT_VIEW_CLAIM =
  'Bu kayıt sonradan değiştirilmediğini, silinmediğini, yeniden sıralanmadığını veya geriye tarih atılmadığını gösterir. Oluştuğu anda doğru olduğunu kanıtlamaz.'

/**
 * Exact-match presentation map. The receipt / LiveProof JSON is not rewritten.
 * Unknown strings are returned unchanged — no guessed translation.
 */
const PRESENTATION_TR: Record<string, string> = {
  'These records have not been altered, deleted, reordered or backdated after creation. This does NOT prove they were correct at creation time.':
    'Bu kayıtlar oluşturulduktan sonra değiştirilmedi, silinmedi, yeniden sıralanmadı veya geriye tarih atılmadı. Oluşturuldukları anda doğru olduklarını kanıtlamaz.',
  'Synthetic demo data, not real customer data.':
    'Sentetik demo verisi, gerçek müşteri verisi değil.',
  'actor is a service identity, not a natural person.':
    'aktör bir hizmet kimliği, gerçek kişi değil.',
  'Anchor may be pending — Bitcoin attestation takes hours.':
    'Çıpa pending olabilir — Bitcoin tasdiki saatler sürer.',
  'This demo is not anchored — the chain head was never sent to a calendar.':
    'Bu demo çıpalanmıyor — zincir başı hiçbir zaman damgasına gönderilmedi.',
  'Signature is meaningless: ephemeral mode (CONARIUM_PROOF_ALLOW_EPHEMERAL=1); not a compliance attestation.':
    'İmza anlamsız: ephemeral kip (CONARIUM_PROOF_ALLOW_EPHEMERAL=1); tasdik değil.',
  'revenue by month': 'aylık ciro',
  'customer list': 'müşteri listesi',
  'closed table': 'kapalı tablo',
  'not permitted by policy': 'politika izin vermiyor',
}

export function presentKnownText(text: string): string {
  if (Object.prototype.hasOwnProperty.call(PRESENTATION_TR, text)) {
    return PRESENTATION_TR[text]
  }
  return text
}

export function resolveAnchorDisplay(
  anchor: { state: string } | null | undefined,
  opts: { verified?: boolean; display?: AnchorDisplay } = {},
): AnchorDisplay | null {
  if (!anchor) return null
  if (opts.display) return opts.display
  if (opts.verified === true) return anchor.state === 'bitcoin' ? 'verified' : 'pending'
  if (anchor.state === 'pending') return 'pending'
  return 'unverified'
}

export function proofToView(proof: ProofLike): ReceiptView {
  const display = resolveAnchorDisplay(proof.anchor, { verified: proof.anchorVerified })
  return {
    title: `${proof.engine.name} ${proof.engine.version}`,
    generatedAt: proof.generatedAt,
    limitations: [...(proof.limitations || [])],
    claim: proof.claim,
    operations: (proof.operations || []).map((o) => ({ ...o })),
    chain: { seq: proof.chain.seq, entries: proof.chain.entries, head: proof.chain.head },
    signature: proof.signature
      ? { alg: proof.signature.alg, keyId: proof.signature.keyId, meaning: proof.signatureMeaning }
      : null,
    signatureAbsentNote: proof.signature ? undefined : proof.signatureMeaning ? undefined : 'Bu kipte imza anlamsız.',
    publicKey: proof.publicKey,
    verify: proof.verify,
    anchor: proof.anchor ? { ...proof.anchor, display: display ?? 'unverified' } : null,
    jsonHref: '/proof?format=json',
  }
}

export interface ReceiptToViewExtras {
  publicKey?: string | null
  verify?: string
  entries?: number
  chainIntegrity?: ReceiptChainCheck
  jsonHref?: string
  limitations?: string[]
  claim?: string
  /** Sidecar OTS result. Absent = treat claimed bitcoin as unverified. */
  anchorDisplay?: AnchorDisplay
}

export function receiptToView(receipt: Receipt, extras: ReceiptToViewExtras = {}): ReceiptView {
  const limitations: string[] = extras.limitations ? [...extras.limitations] : []
  if (!extras.limitations) {
    if (receipt.model?.source === 'undeclared') limitations.push('model bildirmedi (undeclared).')
    if (receipt.client?.source === 'undeclared') limitations.push('istemci bildirmedi (undeclared).')
    const display = resolveAnchorDisplay(receipt.anchor, { display: extras.anchorDisplay })
    if (!receipt.anchor) limitations.push('çıpa yok.')
    else if (display === 'pending') {
      limitations.push('çıpa durumu: pending — Bitcoin tasdiki henüz yok. Saklanmıyor.')
    } else if (display === 'unverified') {
      limitations.push('çıpa doğrulanmadı — ham state güven sinyali değil.')
    }
    if (!receipt.sig) limitations.push('imza yok — bu satır tasdik değil.')
    for (const f of receipt.flags || []) limitations.push(f)
  }

  const decision = receipt.policy?.decision ?? 'deny'
  const denied = receipt.outcome?.denied || decision === 'deny'

  return {
    title: `Makbuz ${receipt.id}`,
    generatedAt: receipt.ts,
    limitations,
    claim: extras.claim ?? RECEIPT_VIEW_CLAIM,
    operations: [
      {
        request: [receipt.request?.tool, receipt.request?.target].filter(Boolean).join(' '),
        policy: decision,
        rowsReturned: receipt.masking?.rowsReturned,
        maskedCount: receipt.masking?.maskedCount,
        reason: denied ? receipt.outcome?.status || 'denied' : undefined,
      },
    ],
    chain: {
      seq: receipt.chain.seq,
      entries: extras.entries,
      head: receipt.chain.hash,
    },
    chainIntegrity: extras.chainIntegrity,
    signature: receipt.sig
      ? { alg: receipt.sig.alg, keyId: receipt.sig.keyId, meaning: true }
      : null,
    signatureAbsentNote: receipt.sig ? undefined : 'üretilemedi',
    publicKey: extras.publicKey ?? null,
    verify: extras.verify ?? 'npx conarium-verify <receipts.jsonl> --pubkey <key.pub.pem>',
    anchor: receipt.anchor
      ? {
          ...receipt.anchor,
          display: resolveAnchorDisplay(receipt.anchor, { display: extras.anchorDisplay }) ?? 'unverified',
        }
      : null,
    jsonHref: extras.jsonHref,
  }
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;'
    if (c === '<') return '&lt;'
    if (c === '>') return '&gt;'
    if (c === '"') return '&quot;'
    return '&#39;'
  })
}

function shortHead(head: string): string {
  const hex = head.startsWith('sha256:') ? head.slice(7) : head
  if (hex.length <= 20) return head
  return `sha256:${hex.slice(0, 12)}…${hex.slice(-8)}`
}

function policyLabel(p: PolicyDecision): string {
  if (p === 'allow') return 'allow'
  if (p === 'partial') return 'partial'
  return 'deny'
}

function opRows(ops: ReceiptViewOperation[]): string {
  return ops
    .map((o) => {
      const extra = o.policy === 'deny' ? o.reason || '' : o.sample || ''
      return `<tr>
        <td>${esc(presentKnownText(o.request))}</td>
        <td class="pol ${esc(o.policy)}">${esc(policyLabel(o.policy))}</td>
        <td>${o.rowsReturned == null ? '—' : esc(o.rowsReturned)}</td>
        <td>${o.maskedCount == null ? '—' : esc(o.maskedCount)}</td>
        <td>${esc(presentKnownText(extra))}</td>
      </tr>`
    })
    .join('')
}

function chainIntegrityHtml(check?: ReceiptChainCheck): string {
  if (!check) return ''
  if (check.ok) {
    if (check.entries === 0) return ''
    return `<p class="chain-ok">zincir sağlam</p>`
  }
  return `<p class="chain-broken">kırık (satır ${esc(check.brokenAt)})</p>`
}

function innerHtml(view: ReceiptView, localId: string): string {
  const lims = (view.limitations || []).map((l) => `<li>${esc(presentKnownText(l))}</li>`).join('')
  const display = resolveAnchorDisplay(view.anchor, { display: view.anchor?.display })
  const pending = display === 'pending'
  const head = view.chain?.head || ''
  const sig = view.signature
  const jsonLink = view.jsonHref
    ? `<p><a class="btn" href="${esc(view.jsonHref)}">Ham JSON</a></p>`
    : ''

  return `
  <h1>${esc(view.title)}</h1>
  <p class="muted">Üretildi: <time datetime="${esc(view.generatedAt)}">${esc(view.generatedAt)}</time><span id="${localId}"></span></p>
  ${chainIntegrityHtml(view.chainIntegrity)}

  <section class="limits">
    <h2>Sınırlar</h2>
    <ul>${lims || '<li>sınır listesi boş — gizlenmedi, yazılmadı.</li>'}</ul>
    ${pending ? `<p class="pending">Çıpa durumu: <strong>pending</strong> — Bitcoin tasdiki henüz yok. Saklanmıyor.</p>` : ''}
    ${display === 'unverified' ? `<p class="muted">Çıpa: doğrulanmadı${view.anchor?.log ? ` (${esc(view.anchor.log)})` : ''}</p>` : ''}
    ${display === 'verified' ? `<p class="muted">Çıpa: bitcoin${view.anchor?.log ? ` (${esc(view.anchor.log)})` : ''}</p>` : ''}
    ${!view.anchor ? `<p class="muted">Çıpa yok.</p>` : ''}
  </section>

  ${view.claim ? `<p>${esc(presentKnownText(view.claim))}</p>` : ''}

  <h2>İşlemler</h2>
  <table>
    <thead><tr><th>İstek</th><th>Politika</th><th>Dönen</th><th>Maske</th><th>Örnek / neden</th></tr></thead>
    <tbody>${opRows(view.operations || [])}</tbody>
  </table>

  <h2>Zincir</h2>
  <dl>
    <dt>seq</dt><dd>${esc(view.chain?.seq)}</dd>
    <dt>entries</dt><dd>${view.chain?.entries == null ? '—' : esc(view.chain.entries)}</dd>
    <dt>head</dt><dd>
      <div class="row">
        <code title="${esc(head)}">${esc(shortHead(head))}</code>
        <button type="button" data-copy-from="head-full">Kopyala</button>
      </div>
      <pre id="head-full" hidden>${esc(head)}</pre>
    </dd>
  </dl>

  <h2>İmza</h2>
  ${
    sig
      ? `<dl>
    <dt>alg</dt><dd>${esc(sig.alg)}</dd>
    <dt>keyId</dt><dd><code>${esc(sig.keyId)}</code></dd>
    <dt>anlamlı</dt><dd>${sig.meaning ? 'evet' : 'hayır — ephemeral, tasdik değil'}</dd>
  </dl>
  ${
    view.publicKey
      ? `<p class="muted">Açık anahtar</p>
  <div class="row"><button type="button" data-copy-from="pubkey">Kopyala</button></div>
  <pre id="pubkey">${esc(view.publicKey)}</pre>`
      : ''
  }`
      : `<p>İmza yok.${view.signatureAbsentNote ? ` ${esc(view.signatureAbsentNote)}` : ''}</p>`
  }

  <h2>Doğrulama</h2>
  <div class="row"><button type="button" data-copy-from="verify">Kopyala</button></div>
  <pre id="verify">${esc(view.verify)}</pre>
  ${jsonLink}`
}

const DOCUMENT_CSS = `:root{
  --bg:#f4f1ea;--fg:#1a1a16;--muted:#5c5a52;--line:#d4cfc3;
  --allow:#1b6b3a;--partial:#8a6a00;--deny:#9b1c2c;
  --box:#fffdf7;--btn:#e8e2d4;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#12140f;--fg:#ece8dc;--muted:#a39d8c;--line:#2e3228;
    --allow:#6fdb96;--partial:#e6c35c;--deny:#ff8a96;
    --box:#1a1d16;--btn:#2a2e24;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,Segoe UI,sans-serif}
main{max-width:44rem;margin:0 auto;padding:1.5rem 1rem 3rem}
h1{font-size:1.25rem;font-weight:650;margin:0 0 .35rem}
h2{font-size:1rem;font-weight:650;margin:1.6rem 0 .5rem}
p,li{color:var(--fg)}
.muted{color:var(--muted);font-size:.92rem}
.limits{border:1px solid var(--deny);background:var(--box);padding:.8rem 1rem;margin:1rem 0}
.limits h2{margin-top:0;color:var(--deny)}
.limits ul{margin:.4rem 0 0;padding-left:1.1rem}
.pending{border:1px solid var(--partial);padding:.6rem .8rem;margin:.6rem 0;background:var(--box)}
.chain-ok{color:var(--allow);font-weight:650}
.chain-broken{color:var(--deny);font-weight:650}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{text-align:left;padding:.45rem .4rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:.78rem}
.pol.allow{color:var(--allow);font-weight:650}
.pol.partial{color:var(--partial);font-weight:650}
.pol.deny{color:var(--deny);font-weight:650}
pre,code{font-family:ui-monospace,Consolas,monospace;font-size:.82rem;word-break:break-all}
pre{background:var(--box);border:1px solid var(--line);padding:.7rem;white-space:pre-wrap}
.row{display:flex;gap:.5rem;align-items:flex-start;flex-wrap:wrap}
button,a.btn{font:inherit;font-size:.8rem;background:var(--btn);color:var(--fg);border:1px solid var(--line);padding:.25rem .55rem;cursor:pointer;text-decoration:none}
dl{display:grid;grid-template-columns:7rem 1fr;gap:.35rem .6rem;margin:0}
dt{color:var(--muted)}
dd{margin:0}`

const FRAGMENT_CSS = `.cnr-rv{
  --rv-fg:#f8fafc;--rv-muted:#94a3b8;--rv-line:rgba(255,255,255,.12);
  --allow:#10b981;--partial:#e6c35c;--deny:#ef4444;
  --rv-box:rgba(0,0,0,.25);--rv-btn:rgba(255,255,255,.08);
  color:var(--rv-fg);font:15px/1.5 inherit;
}
.cnr-rv h1{font-size:1.15rem;font-weight:650;margin:0 0 .35rem}
.cnr-rv h2{font-size:1rem;font-weight:650;margin:1.4rem 0 .5rem}
.cnr-rv .muted{color:var(--rv-muted);font-size:.92rem}
.cnr-rv .limits{border:1px solid var(--deny);background:var(--rv-box);padding:.8rem 1rem;margin:1rem 0}
.cnr-rv .limits h2{margin-top:0;color:var(--deny)}
.cnr-rv .limits ul{margin:.4rem 0 0;padding-left:1.1rem}
.cnr-rv .pending{border:1px solid var(--partial);padding:.6rem .8rem;margin:.6rem 0;background:var(--rv-box)}
.cnr-rv .chain-ok{color:var(--allow);font-weight:650}
.cnr-rv .chain-broken{color:var(--deny);font-weight:650}
.cnr-rv table{width:100%;border-collapse:collapse;font-size:.92rem}
.cnr-rv th,.cnr-rv td{text-align:left;padding:.45rem .4rem;border-bottom:1px solid var(--rv-line);vertical-align:top}
.cnr-rv th{color:var(--rv-muted);font-weight:600;font-size:.78rem}
.cnr-rv .pol.allow{color:var(--allow);font-weight:650}
.cnr-rv .pol.partial{color:var(--partial);font-weight:650}
.cnr-rv .pol.deny{color:var(--deny);font-weight:650}
.cnr-rv pre,.cnr-rv code{font-family:ui-monospace,Consolas,monospace;font-size:.82rem;word-break:break-all}
.cnr-rv pre{background:var(--rv-box);border:1px solid var(--rv-line);padding:.7rem;white-space:pre-wrap}
.cnr-rv .row{display:flex;gap:.5rem;align-items:flex-start;flex-wrap:wrap}
.cnr-rv button,.cnr-rv a.btn{font:inherit;font-size:.8rem;background:var(--rv-btn);color:var(--rv-fg);border:1px solid var(--rv-line);padding:.25rem .55rem;cursor:pointer;text-decoration:none}
.cnr-rv dl{display:grid;grid-template-columns:7rem 1fr;gap:.35rem .6rem;margin:0}
.cnr-rv dt{color:var(--rv-muted)}
.cnr-rv dd{margin:0}`

function copyScript(localId: string): string {
  return `<script>
(function(){
  var t = document.querySelector('time[datetime]');
  var slot = document.getElementById(${JSON.stringify(localId)});
  if (t && slot) {
    var d = new Date(t.getAttribute('datetime'));
    if (!isNaN(d.getTime())) slot.textContent = '  ·  yerel ' + d.toLocaleString();
  }
  document.querySelectorAll('[data-copy-from]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var el = document.getElementById(btn.getAttribute('data-copy-from'));
      if (!el) return;
      var text = el.textContent || '';
      function done(){ btn.textContent = 'Kopyalandı'; setTimeout(function(){ btn.textContent = 'Kopyala'; }, 1400); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function(){
          var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); } catch (e) {}
          ta.remove(); done();
        });
      } else {
        var ta2 = document.createElement('textarea'); ta2.value = text; document.body.appendChild(ta2); ta2.select();
        try { document.execCommand('copy'); } catch (e2) {}
        ta2.remove(); done();
      }
    });
  });
})();
</script>`
}

export function renderReceiptHtml(view: ReceiptView, opts: { mode?: 'document' | 'fragment' } = {}): string {
  const mode = opts.mode ?? 'document'
  const localId = mode === 'document' ? 't-local' : 'rv-local'
  const body = innerHtml(view, localId)
  if (mode === 'fragment') {
    return `<div class="cnr-rv"><style>${FRAGMENT_CSS}</style>${body}${copyScript(localId)}</div>`
  }
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conarium — kanıt</title>
<style>
${DOCUMENT_CSS}
</style>
</head>
<body>
<main>
${body}
</main>
${copyScript(localId)}
</body>
</html>`
}

/** @deprecated name kept for the demo route; same function. */
export const renderProofHtml = (proof: ProofLike): string =>
  renderReceiptHtml(proofToView(proof), { mode: 'document' })

export const wantsProofHtml = wantsReceiptHtml
export const serializeProofJson = serializeReceiptJson
