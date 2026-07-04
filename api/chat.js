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

function requireCallerAuth(req) {
  const expected = getCallerAuthToken();
  if (!expected) return; // public mode: no token configured, anyone may call (rate-limited)
  const auth = getHeader(req, 'authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : getHeader(req, 'x-conarium-client-key');
  if (token !== expected) {
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
  const ip = getHeader(req, 'x-forwarded-for')?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
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

export const __test = { getUpstreamUrl, requireCallerAuth, enforceRateLimit, enforceOrigin, getCallerAuthToken, getAllowedOrigins, rateBuckets };
