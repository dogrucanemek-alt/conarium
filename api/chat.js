import crypto from 'node:crypto';

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;
const rateBuckets = new Map();

function getHeader(req, name) {
  const value = req.headers?.[name.toLowerCase()] ?? req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function getCallerAuthToken() {
  const value = process.env.CONARIUM_CHAT_AUTH_TOKEN;
  return value && value.trim() ? value : null;
}

/** Ucun herkese acik olmasina BILEREK karar verildi mi? */
function isPublicModeExplicit() {
  const v = process.env.CONARIUM_CHAT_PUBLIC;
  return v === '1' || v === 'true';
}

/** Sabit zamanli karsilastirma — iki tarafi da sha256'la, uzunluklar esitlensin. */
function tokenEquals(supplied, expected) {
  if (typeof supplied !== 'string' || !supplied) return false;
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireCallerAuth(req) {
  const expected = getCallerAuthToken();
  if (!expected) {
    // Eskiden burada sessiz bir `return` vardi: token tanimli degilse herkes
    // cagirabiliyordu. Ama YAPILANDIRMANIN EKSIK olmasi ile ucun acik olmasina
    // KARAR VERILMIS olmasi ayni sey degil — ilki kaza, ikincisi tercih. Kazayla
    // acik kalan bir uc, upstream model anahtarini yabancilar adina yakar.
    // Artik acik mod ancak acikca istenirse calisir.
    if (isPublicModeExplicit()) return;
    const err = new Error(
      'Chat proxy yapilandirilmamis: CONARIUM_CHAT_AUTH_TOKEN tanimlayin, ya da ucun ' +
      'bilerek herkese acik olmasini istiyorsaniz CONARIUM_CHAT_PUBLIC=1 verin.'
    );
    err.statusCode = 503;
    throw err;
  }
  const auth = getHeader(req, 'authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : getHeader(req, 'x-conarium-client-key');
  if (!tokenEquals(token, expected)) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
}

function getAllowedOrigins() {
  const raw = process.env.CONARIUM_CHAT_ALLOWED_ORIGINS;
  if (!raw || !raw.trim()) return null;
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function normalizeOrigin(value) {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function enforceOrigin(req) {
  const allowed = getAllowedOrigins();
  if (!allowed) return; // no allowlist configured: allow all origins (public widget)
  const originHeader = getHeader(req, 'origin');
  let candidate = originHeader ? normalizeOrigin(originHeader) : null;
  if (!candidate) {
    const referer = getHeader(req, 'referer');
    candidate = referer ? normalizeOrigin(referer) : null;
  }
  if (!candidate || !allowed.includes(candidate)) {
    const err = new Error('Forbidden origin');
    err.statusCode = 403;
    throw err;
  }
}

function enforceRateLimit(req) {
  const now = Date.now();
  // Opportunistic eviction: bound the bucket map so many unique IPs can't grow it
  // without limit (memory leak / DoS).
  if (rateBuckets.size > 5000) {
    for (const [k, b] of rateBuckets) if (now - b.start >= WINDOW_MS) rateBuckets.delete(k);
  }
  // The LEFTMOST x-forwarded-for entry is client-controlled (a caller can prepend
  // arbitrary values to hop buckets). Trust order: x-real-ip (set by the platform
  // proxy), then the RIGHTMOST forwarded hop (appended by the nearest trusted proxy),
  // then the socket peer. Deployment assumption: this function sits behind a proxy
  // (Vercel) that overwrites x-real-ip; if you expose it directly, strip inbound
  // x-real-ip/x-forwarded-for at your edge or the bucket key is spoofable.
  const ip = getHeader(req, 'x-real-ip')?.trim()
    || getHeader(req, 'x-forwarded-for')?.split(',').map(s => s.trim()).filter(Boolean).pop()
    || req.socket?.remoteAddress || 'unknown';
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start >= WINDOW_MS) {
    rateBuckets.set(ip, { start: now, count: 1 });
    return;
  }
  bucket.count += 1;
  if (bucket.count > MAX_REQUESTS_PER_WINDOW) {
    const err = new Error('Rate limit exceeded');
    err.statusCode = 429;
    throw err;
  }
}

function getUpstreamUrl() {
  const upstream = new URL(requireEnv('CONARIUM_CHAT_UPSTREAM_URL'));
  if (upstream.protocol !== 'https:') {
    throw new Error('CONARIUM_CHAT_UPSTREAM_URL must use HTTPS');
  }
  return upstream;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ reply: 'POST only' });
    return;
  }

  try {
    enforceOrigin(req);
    requireCallerAuth(req);
    enforceRateLimit(req);

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    const r = await fetch(getUpstreamUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-conarium-key': requireEnv('CONARIUM_PROXY_KEY'),
      },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      // Never launder an upstream error into a 200. Report a gateway failure.
      res.status(502).json({ reply: 'Unable to answer right now.' });
      return;
    }
    const d = await r.json();
    res.status(200).json(d);
  } catch (e) {
    const status = e.statusCode || 502;
    res.status(status).json({ reply: status === 401 ? 'Unauthorized' : 'Unable to answer right now.' });
  }
}

export const __test = { getUpstreamUrl, requireCallerAuth, enforceRateLimit, enforceOrigin, getCallerAuthToken, getAllowedOrigins, isPublicModeExplicit, rateBuckets };
