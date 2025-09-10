export const config = { runtime: 'edge' };
const HG = 'https://api.heygen.com/v1';

const json = (data, status=200) => new Response(JSON.stringify(data), {
  status, headers:{'content-type':'application/json','access-control-allow-origin':'*'}
});

async function heygen(path, method='GET', body=null){
  const r = await fetch(`${HG}/${path}`, {
    method,
    headers:{ 'X-Api-Key': process.env.HEYGEN_API_KEY, 'content-type':'application/json' },
    body: body ? JSON.stringify(body) : null
  });
  const t = await r.text(); let d={}; try{ d=JSON.parse(t);}catch{}
  if(!r.ok) return json({ ok:false, error:t }, r.status);
  return d;
}

export default async function handler(req){
  if (req.method==='OPTIONS') return json({},204);
  const { avatar_id, quality, visitor_id } = await req.json();
  const body = { version:'v2', quality: quality||'high' };
  if (avatar_id) body.avatar_id = avatar_id;

  const created = await heygen('streaming.new','POST', body);
  const d = created?.data || {};
  if (!d.session_id) return json({ ok:false, error:'no_session' }, 500);

  let ws = d.url || ''; let token = d.access_token || '';
  if (!token) {
    const tk = await heygen('streaming.create_token','POST',{ session_id: d.session_id });
    token = tk?.data?.token || tk?.data?.access_token || '';
  }
  await heygen('streaming.start','POST',{ session_id: d.session_id });

  return json({ ok:true, session_id: d.session_id, ws_url: ws, access_token: token, quality: body.quality });
}
