export const config = { runtime: 'edge' };

const HG = 'https://api.heygen.com/v1';

const json = (data, status=200, headers={}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type':'application/json', ...headers }
  });

// CORS dynamique: autorise uniquement les origines listées dans CORS_ORIGINS (CSV) ou toutes si "*"
function corsHeaders(req){
  const allow = (process.env.CORS_ORIGINS || '*').split(',').map(s=>s.trim()).filter(Boolean);
  const origin = req.headers.get('origin') || '';
  const ok = allow.includes('*') || allow.includes(origin);
  return {
    'access-control-allow-origin': ok ? (allow.includes('*') ? '*' : origin) : 'null',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization'
  };
}

async function heygen(path, method='GET', body=null){
  const r = await fetch(`${HG}/${path}`, {
    method,
    headers:{ 'X-Api-Key': process.env.HEYGEN_API_KEY, 'content-type':'application/json' },
    body: body ? JSON.stringify(body) : null
  });
  const t = await r.text(); let d={}; try{ d=JSON.parse(t);}catch{}
  if(!r.ok) throw new Error(t || `HTTP ${r.status}`);
  return d;
}

export default async function handler(req){
  const CORS = corsHeaders(req);
  if (req.method==='OPTIONS') return new Response(null, { status:204, headers:CORS });

  try{
    const avatar_id = '5c3a094338ac46649c630d3929a78196';
    const quality = 'high';
    const created = await heygen('streaming.new','POST', { version:'v2', quality, avatar_id });
    const d = created?.data || {};
    if (!d.session_id) return json({ ok:false, error:'no_session' }, 500, CORS);

    let ws = d.url || ''; let token = d.access_token || '';
    if (!token) {
      const tk = await heygen('streaming.create_token','POST',{ session_id: d.session_id });
      token = tk?.data?.token || tk?.data?.access_token || '';
    }
    await heygen('streaming.start','POST',{ session_id: d.session_id });

    return json({ ok:true, session_id: d.session_id, ws_url: ws, access_token: token, quality }, 200, CORS);
  }catch(e){
    return json({ ok:false, error: String(e?.message||e) }, 500, CORS);
  }
}
