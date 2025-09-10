export const config = { runtime: 'edge' };

const HG = 'https://api.heygen.com/v1';

// helpers
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });

function corsHeaders(req) {
  const allow = (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const origin = req.headers.get('origin') || '';
  const ok = allow.includes('*') || allow.includes(origin);
  return {
    'access-control-allow-origin': ok ? (allow.includes('*') ? '*' : origin) : 'null',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization'
  };
}

async function heygen(path, method = 'GET', body = null) {
  const r = await fetch(`${HG}/${path}`, {
    method,
    headers: {
      'X-Api-Key': process.env.HEYGEN_API_KEY,
      'content-type': 'application/json'
    },
    body: body ? JSON.stringify(body) : null
  });
  const t = await r.text();
  let d = {};
  try { d = JSON.parse(t); } catch { /* non-JSON */ }
  if (!r.ok) throw new Error(t || `HTTP ${r.status}`);
  return d;
}

export default async function handler(req) {
  const CORS = corsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    const { avatar_id, quality } = await req.json();
    const body = { version: 'v2', quality: quality || 'high' };
    if (avatar_id) body.avatar_id = avatar_id;

    // 1) create session
    const created = await heygen('streaming.new', 'POST', body);
    const d = created?.data || {};
    if (!d.session_id) {
      return json({ ok: false, error: 'no_session' }, 500, CORS);
    }

    // 2) ws url + token
    const ws = d.url || '';
    let token = d.access_token || '';
    if (!token) {
      const tk = await heygen('streaming.create_token', 'POST', { session_id: d.session_id });
      token = tk?.data?.token || tk?.data?.access_token || '';
    }

    // 3) start session
    await heygen('streaming.start', 'POST', { session_id: d.session_id });

    // 4) return
    return json(
      {
        ok: true,
        session_id: d.session_id,
        ws_url: ws,
        access_token: token,
        quality: body.quality
      },
      200,
      CORS
    );
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500, CORS);
  }
}
