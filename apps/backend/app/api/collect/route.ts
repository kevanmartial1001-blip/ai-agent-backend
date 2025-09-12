/* app/api/collect/route.ts
   Accepts { session_id, company, website, email }
   - Basic validation
   - Forwards to your Apps Script (Google Sheets) endpoint via KB_COLLECT_URL
   Env:
     - KB_COLLECT_URL = https://script.google.com/macros/s/XXXXX/exec  (must accept POST JSON)
*/
export const runtime = 'edge';

function isEmail(v: string){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v || ''); }
function normUrl(v?: string){
  if (!v) return '';
  const has = /^https?:\/\//i.test(v); return has ? v : ('https://' + v);
}

export async function POST(req: Request) {
  try {
    const { session_id, company, website, email } = await req.json();

    if (!company || !email) {
      return new Response(JSON.stringify({ error: 'company and email are required' }), { status: 400 });
    }
    if (!isEmail(email)) {
      return new Response(JSON.stringify({ error: 'invalid email' }), { status: 400 });
    }

    const payload = {
      fn: 'collect_contact',
      session_id: String(session_id || ''),
      company: String(company || ''),
      website: normUrl(String(website || '')),
      email: String(email || ''),
      ts: Date.now()
    };

    const url = process.env.KB_COLLECT_URL;
    if (!url) {
      // No external storage configured; accept anyway (you can view logs in Vercel)
      console.log('[collect] received but KB_COLLECT_URL not set', payload);
      return new Response(JSON.stringify({ ok: true, stored: 'local-log' }), { status: 200 });
    }

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store'
    });

    if (!r.ok) {
      const txt = await r.text().catch(()=> '');
      return new Response(JSON.stringify({ error: 'upstream failed', detail: txt }), { status: 502 });
    }

    const data = await r.json().catch(()=> ({}));
    return new Response(JSON.stringify({ ok: true, upstream: data }), { status: 200 });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: 'bad request' }), { status: 400 });
  }
}
