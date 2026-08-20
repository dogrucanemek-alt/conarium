/**
 * Live verifiable proof payload (Katman 0 / B1).
 * Runs three synthetic governance operations — no real customer data.
 * Intended for Hetzner demo GET /proof (write now, deploy only with patron approval).
 */
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from 'crypto';
import { createRequire } from 'module';
import { readFileSync, existsSync, realpathSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadReceiptView } from './load-receipt-view.js';
import { loadGovernance } from './load-governance.js';
const HERE = dirname(fileURLToPath(import.meta.url));
function readCoreVersion(file) {
    try {
        if (!existsSync(file))
            return null;
        const pkg = JSON.parse(readFileSync(file, 'utf8'));
        if (pkg.name !== '@conarium-ai/core')
            return null;
        if (typeof pkg.version !== 'string' || !pkg.version.trim())
            return null;
        return pkg.version.trim();
    }
    catch {
        return null;
    }
}
/**
 * Engine version for /proof. This repo's package.json is still named
 * `@conarium-ai/core@0.1.0` (the site, not the published engine). Using
 * `npm_package_version` or a frozen `'0.1.0'` made the live proof lie
 * while MCP serverInfo said 0.2.7.
 *
 * Order: explicit opt → CONARIUM_ENGINE_VERSION → CONARIUM_CORE_PACKAGE_JSON
 * → CONARIUM_ROOT/package.json → installed @conarium-ai/core if it is not
 * this repo. Otherwise `'unknown'` — never a hardcoded product cut.
 */
export function resolveEngineVersion(explicit) {
    if (explicit && explicit.trim())
        return explicit.trim();
    const fromEnv = process.env.CONARIUM_ENGINE_VERSION?.trim();
    if (fromEnv)
        return fromEnv;
    const pinned = process.env.CONARIUM_CORE_PACKAGE_JSON?.trim();
    if (pinned) {
        const v = readCoreVersion(pinned);
        if (v)
            return v;
    }
    const root = process.env.CONARIUM_ROOT?.trim();
    if (root) {
        const v = readCoreVersion(join(root, 'package.json'));
        if (v)
            return v;
    }
    try {
        const require = createRequire(import.meta.url);
        const resolved = require.resolve('@conarium-ai/core/package.json');
        const selfPkg = join(HERE, '..', 'package.json');
        let same = false;
        try {
            same = realpathSync(resolved) === realpathSync(selfPkg);
        }
        catch {
            same = resolved === selfPkg;
        }
        if (!same) {
            const v = readCoreVersion(resolved);
            if (v)
                return v;
        }
    }
    catch {
        /* not installed as a separate package */
    }
    return 'unknown';
}
export const PROOF_CLAIM = 'These records have not been altered, deleted, reordered or backdated after creation. This does NOT prove they were correct at creation time.';
export const PROOF_LIMITATIONS = [
    'Synthetic demo data, not real customer data.',
    'actor is a service identity, not a natural person.',
];
/** Honest when no stamp file matches this head. HTML translates via PRESENTATION_TR. */
export const UNANCHORED_LIMITATION = 'This demo is not anchored — the chain head was never sent to a calendar.';
/** Added to `limitations` when CONARIUM_PROOF_ALLOW_EPHEMERAL=1. */
export const EPHEMERAL_SIGNATURE_LIMITATION = 'Signature is meaningless: ephemeral mode (CONARIUM_PROOF_ALLOW_EPHEMERAL=1); not a compliance attestation.';
const DEMO_POLICY = {
    maxRows: 50,
    allowTables: ['public.metrics_monthly', 'public.contacts'],
    denyTables: ['public.closed_vault'],
    maskColumns: ['*.email', '*.full_name'],
};
function loadSigningKey() {
    const keyPath = process.env.CONARIUM_PROOF_SIGNING_KEY;
    const keyId = process.env.CONARIUM_PROOF_KEY_ID || 'cnr-demo';
    if (keyPath && existsSync(keyPath)) {
        const privatePem = readFileSync(keyPath, 'utf-8');
        const privateKey = createPrivateKey(privatePem);
        const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
        return { keyId, privatePem, publicPem };
    }
    if (process.env.CONARIUM_PROOF_ALLOW_EPHEMERAL === '1') {
        return 'ephemeral';
    }
    throw new Error('buildLiveProof: refusing unsigned proof — set CONARIUM_PROOF_SIGNING_KEY, or explicitly CONARIUM_PROOF_ALLOW_EPHEMERAL=1 (signature will be null / meaningless)');
}
async function runEngineOps() {
    const { Governance } = await loadGovernance();
    const gov = new Governance(DEMO_POLICY);
    const ops = [];
    // 1) allowed aggregate — no PII
    try {
        gov.guardQuery('SELECT month, revenue FROM public.metrics_monthly LIMIT 12');
        const rows = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, revenue: 1000 + i }));
        const masked = gov.maskPII(rows);
        ops.push({
            request: 'revenue by month',
            policy: 'allow',
            rowsReturned: rows.length,
            maskedCount: masked.count,
        });
    }
    catch (err) {
        ops.push({
            request: 'revenue by month',
            policy: 'deny',
            reason: err instanceof Error ? err.message : 'denied',
        });
    }
    // 2) contacts with emails → masked
    try {
        gov.guardQuery('SELECT id, email, full_name FROM public.contacts LIMIT 5');
        const rows = [
            { id: 1, email: 'alpha@example.com', full_name: 'Alpha One', note: '4111111111111111xy' },
            { id: 2, email: 'beta@example.com', full_name: 'Beta Two' },
            { id: 3, email: 'gamma@example.com', full_name: 'Gamma Three' },
            { id: 4, email: 'delta@example.com', full_name: 'Delta Four' },
            { id: 5, email: 'epsilon@example.com', full_name: 'Epsilon Five' },
        ];
        const masked = gov.maskPII(rows);
        const sampleRow = Array.isArray(masked.masked) ? masked.masked[0] : masked.masked;
        const sampleNote = sampleRow && typeof sampleRow === 'object' && sampleRow !== null && 'note' in sampleRow
            ? String(sampleRow.note)
            : '[MASKED_PII]';
        ops.push({
            request: 'customer list',
            policy: masked.count > 0 ? 'partial' : 'allow',
            rowsReturned: rows.length,
            maskedCount: masked.count,
            sample: sampleNote,
        });
    }
    catch (err) {
        ops.push({
            request: 'customer list',
            policy: 'deny',
            reason: err instanceof Error ? err.message : 'denied',
        });
    }
    // 3) closed table → deny (no table name in public reason)
    try {
        gov.guardQuery('SELECT * FROM public.closed_vault');
        ops.push({
            request: 'closed table',
            policy: 'allow',
            rowsReturned: 0,
            maskedCount: 0,
        });
    }
    catch {
        ops.push({
            request: 'closed table',
            policy: 'deny',
            reason: 'not permitted by policy',
        });
    }
    return ops;
}
/**
 * Attach a stamp only when the file's `ref` equals this request's head.
 * Missing / unreadable / mismatched file → null. Never invent `bitcoin`.
 */
export function readProofAnchor(head, filePath = process.env.CONARIUM_PROOF_ANCHOR_FILE) {
    if (!filePath || !filePath.trim())
        return null;
    try {
        if (!existsSync(filePath))
            return null;
        const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
        if (typeof parsed.ref !== 'string' || parsed.ref !== head)
            return null;
        if (parsed.state !== 'pending' && parsed.state !== 'bitcoin')
            return null;
        if (typeof parsed.log !== 'string' || !parsed.log.trim())
            return null;
        return { log: parsed.log, state: parsed.state, ref: parsed.ref };
    }
    catch {
        return null;
    }
}
export function proofPublicBase() {
    const raw = process.env.CONARIUM_PROOF_PUBLIC_URL?.trim();
    return (raw || 'https://demo.conarium.dev').replace(/\/+$/, '');
}
/**
 * Copy-paste command. Placeholders are gone — the URLs are real.
 *
 * `--anchor-check` reads the sidecar next to the chain (`<chain>.anchors.jsonl`)
 * and exits 14 if a receipt claims an anchor whose record is missing. So the
 * sidecar is part of the download exactly when the page publishes an anchor:
 * naming it while unanchored would fail the `curl -fsS` instead.
 */
export function proofVerifyCommand(base = proofPublicBase(), opts = {}) {
    const chain = `${base}/proof/chain.jsonl`;
    const key = `${base}/proof/key.pem`;
    const steps = [`curl -fsS ${chain} -o chain.jsonl`];
    if (opts.anchored)
        steps.push(`curl -fsS ${chain}.anchors.jsonl -o chain.jsonl.anchors.jsonl`);
    steps.push(`curl -fsS ${key} -o key.pem`);
    steps.push(`curl -fsS ${key}.keyid -o key.pem.keyid`);
    steps.push('node bin/conarium-verify.mjs chain.jsonl --pubkey key.pem --anchor-check');
    return steps.join(' && ');
}
function limitationsFor(anchor, ephemeral) {
    const out = [...PROOF_LIMITATIONS];
    if (!anchor)
        out.push(UNANCHORED_LIMITATION);
    if (ephemeral)
        out.push(EPHEMERAL_SIGNATURE_LIMITATION);
    return out;
}
function signPayload(bodyWithoutSig, privatePem, keyId) {
    const privateKey = createPrivateKey(privatePem);
    const digest = createHash('sha256').update(JSON.stringify(bodyWithoutSig)).digest();
    const value = cryptoSign(null, digest, privateKey).toString('base64');
    return { alg: 'Ed25519', keyId, value };
}
function receiptToOp(r) {
    const request = r.request;
    const policy = r.policy;
    const masking = r.masking;
    const outcome = r.outcome;
    const decision = policy?.decision === 'allow' || policy?.decision === 'partial' || policy?.decision === 'deny'
        ? policy.decision
        : 'deny';
    const op = {
        request: typeof request?.tool === 'string' ? request.tool : 'request',
        policy: decision,
    };
    if (typeof masking?.rowsReturned === 'number')
        op.rowsReturned = masking.rowsReturned;
    if (typeof masking?.maskedCount === 'number')
        op.maskedCount = masking.maskedCount;
    if (decision === 'partial')
        op.sample = '[MASKED_PII]';
    if (outcome?.denied)
        op.reason = 'not permitted by policy';
    return op;
}
/** Persistent demo chain. Missing / unreadable file → null (in-memory ops). */
export function loadProofChain(filePath = process.env.CONARIUM_PROOF_CHAIN) {
    if (!filePath || !filePath.trim())
        return null;
    try {
        if (!existsSync(filePath))
            return null;
        const lines = readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim());
        if (lines.length === 0)
            return null;
        const receipts = lines.map((l) => JSON.parse(l));
        const last = receipts[receipts.length - 1];
        const chain = last?.chain;
        if (typeof chain?.hash !== 'string' || typeof chain.seq !== 'number')
            return null;
        return {
            seq: chain.seq,
            entries: receipts.length,
            head: chain.hash,
            operations: receipts.map(receiptToOp),
        };
    }
    catch {
        return null;
    }
}
/** Build a machine-citable live proof. Never includes raw PII, internal names, or real tables. */
export async function buildLiveProof(opts = {}) {
    const generatedAt = new Date().toISOString();
    const persisted = loadProofChain();
    const operations = persisted ? persisted.operations : await runEngineOps();
    const seq = persisted ? persisted.seq : (opts.seq ?? Number(process.env.CONARIUM_PROOF_SEQ || 1));
    const head = persisted
        ? persisted.head
        : `sha256:${createHash('sha256').update(JSON.stringify({ operations, seq })).digest('hex')}`;
    const entries = persisted ? persisted.entries : seq;
    const keys = loadSigningKey();
    const ephemeral = keys === 'ephemeral';
    const anchor = readProofAnchor(head);
    const base = {
        generatedAt,
        engine: { name: 'conarium', version: resolveEngineVersion(opts.version) },
        operations,
        chain: { seq, head, entries },
        signatureMeaning: !ephemeral,
        anchor,
        verify: proofVerifyCommand(proofPublicBase(), { anchored: anchor !== null }),
        claim: PROOF_CLAIM,
        limitations: limitationsFor(anchor, ephemeral),
    };
    if (ephemeral) {
        return { ...base, signature: null, publicKey: null };
    }
    const signature = signPayload(base, keys.privatePem, keys.keyId);
    return { ...base, signature, publicKey: keys.publicPem };
}
const receiptView = await loadReceiptView();
export function wantsProofHtml(accept, format) {
    return receiptView.wantsReceiptHtml(accept, format);
}
export function serializeProofJson(proof) {
    return receiptView.serializeReceiptJson(proof);
}
export function renderProofHtml(proof) {
    return receiptView.renderReceiptHtml(receiptView.proofToView(proof), { mode: 'document' });
}
/** Forbidden substrings for leak regression (B4.2). */
export const PROOF_LEAK_NEEDLES = [
    'zion',
    'ZION',
    'Codes',
    'codes sync',
    '@example.com',
    'alpha@',
    'beta@',
    'closed_vault',
    'metrics_monthly',
    'public.contacts',
];
//# sourceMappingURL=proof.js.map