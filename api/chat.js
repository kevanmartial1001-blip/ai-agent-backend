// api/chat.js — Node.js serverless, KB safe + rapide, jamais de silence
export const config = { runtime: 'nodejs' };

const HG = 'https://api.heygen.com/v1';

function getCorsHeaders(req) {
  const allow = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
  const origin = (req.headers?.origin) || '';
  const ok = allow.includes('*') || allow.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (allow.includes('*') ? '*' : origin) : 'null',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,authorization'
  };
}
function sendJson(res, data, status = 200, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(data));
}
async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks=[]; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

// ---- KB helpers (Apps Script /exec) ----
const KB_BASE  = () => process.env.KB_BASE;
const KB_TOKEN = () => process.env.KB_TOKEN;
async function kbGet(route, params) {
  const qs  = new URLSearchParams({ ...params, r: route, token: KB_TOKEN() }).toString();
  const url = `${KB_BASE()}?${qs}`;
  const r   = await fetch(url, { cache: 'no-store' });
  const d   = await r.json().catch(()=>({ ok:false, error:'bad_json' }));
  if (!d.ok) throw new Error(d.error || `KB ${route} error`);
  return d.data;
}
async function kbPost(route, body) {
  const url = `${KB_BASE()}?r=${route}&token=${KB_TOKEN()}`;
  const r   = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body||{}) });
  const d   = await r.json().catch(()=>({ ok:false, error:'bad_json' }));
  if (!d.ok) throw new Error(d.error || `KB ${route} post error`);
  return true;
}

// ---- HeyGen speak ----
async function heygenSay(session_id, text) {
  try {
    await fetch(`${HG}/streaming.task`, {
      method:'POST',
      headers:{ 'X-Api-Key': process.env.HEYGEN_API_KEY, 'content-type':'application/json' },
      body: JSON.stringify({ session_id, text, task_type:'repeat', task_mode:'sync' })
    });
  } catch {}
}

// ---- Prompt compact (latence basse) ----
const MINI_PROMPT = [
  "You are Kevin’s AI sales consultant. Use a strict 6-step script: intro → AI familiarity → tailored examples → discovery → 2–3 agent recommendations → CTA for a personalized demo.",
  "Continue from context; do NOT repeat previous lines. Reply in <= 120 words. Default English; fully switch to user language if detected (French = metropolitan).",
  "If user goes off-track: give a brief answer, then return to the current step. Keep it warm and precise."
].join(' ');

// ---- OpenAI call with timeout ----
async function llmReply(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000); // 10s pour baisser la latence
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{ 'authorization':'Bearer '+process.env.OPENAI_API_KEY, 'content-type':'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature:0.2, max_tokens:220, messages }),
      signal: controller.signal
    });
    const txt = await r.text();
    let body={}; try{ body=JSON.parse(txt);}catch{}
    if(!r.ok) throw new Error(body?.error?.message || txt);
    const content = body?.choices?.[0]?.message?.content || '';
    return { ok:true, content };
  } catch(e) {
    return { ok:false, error:String(e?.message||e) };
  } finally {
    clearTimeout(timer);
  }
}
function fallbackReply(userText) {
  const t = (userText||'').slice(0,140);
  return `Quick heads-up: I heard “${t}”. Let me keep us on track — what industry are you in, and what’s your role?`;
}

export default async function handler(req, res) {
  const CORS = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204; for (const [k,v] of Object.entries(CORS)) res.setHeader(k,v); return res.end();
  }

  try {
    const body = await parseBody(req);
    let { session_id, visitor_id, text, lang } = body || {};
    if (!text) return sendJson(res, { ok:false, error:'missing text' }, 400, CORS);

    // Fallback audio-only (pas d’avatar HeyGen) si pas de session
    if (!session_id) session_id = 'local-'+Math.random().toString(36).slice(2);
    const isLocal = String(session_id).startsWith('local-');

    // Log USER
    try { await kbPost('logturn', { session_id, visitor_id, role:'user', text, lang:lang||'' }); } catch {}

    // Récupère un history court (si ça rate, on continue)
    let history=[]; try { history = await kbGet('history', { session_id, limit:'6' }); } catch {}

    // Récupère une KB MINIMALE (robuste, sans destructuring)
    let industry = { industry_id:'universal_business', key_pains:[], success_metrics:[] };
    try { const x = await kbGet('industry', { industry_id:'universal_business' }); industry = { ...industry, ...(x||{}) }; } catch {}
    let persona = { level:'unknown', goals_metrics:[], hot_buttons:[] };
    try { const x = await kbGet('persona', { industry_id: industry.industry_id, level: persona.level }); persona = { ...persona, ...(x||{}) }; } catch {}
    let geo = { country:'', subregion:'', mandatory_disclosures:[], redlines:[] };
    try { const x = await kbGet('geo', { industry_id: industry.industry_id, country:'', subregion:'' }); geo = { ...geo, ...(x||{}) }; } catch {}

    const lines = (label, arr) => (arr && arr.length) ? `- ${label}: ${arr.slice(0,3).join('; ')}` : '';
    const kbPack = [
      `KB PACK (lite):`,
      `INDUSTRY: ${industry.industry_id}`,
      lines('key_pains', industry.key_pains),
      lines('success_metrics', industry.success_metrics),
      `PERSONA: ${persona.level}`,
      lines('goals_metrics', persona.goals_metrics),
      lines('hot_buttons', persona.hot_buttons),
      `GEO: ${geo.country||''}${geo.subregion?(', '+geo.subregion):''}`,
      lines('mandatory_disclosures', geo.mandatory_disclosures),
      lines('redlines', geo.redlines)
    ].filter(Boolean).join('\n');

    const toMsgs = (arr)=>arr.map(t=>({ role: t.role==='assistant'?'assistant':'user', content: t.text })).slice(-6);
    const messages = [
      { role:'system', content: MINI_PROMPT },
      { role:'system', content: kbPack },
      ...toMsgs(history),
      { role:'user', content: String(text) }
    ];

    const llm = await llmReply(messages);
    let reply = '';
    if (llm.ok) {
      // Accepte JSON ou texte simple (pas d’erreur si JSON absent)
      try { const parsed = JSON.parse(llm.content); reply = String(parsed?.reply || ''); }
      catch { reply = String(llm.content || ''); }
    } else {
      reply = fallbackReply(text);
    }
    if (!reply) reply = fallbackReply(text);

    // Log ASSISTANT
    try { await kbPost('logturn', { session_id, visitor_id, role:'assistant', text: reply, lang:lang||'' }); } catch {}

    // Ne parle via HeyGen que si ce n’est pas une session locale (avatar)
    if (!isLocal) { try { await heygenSay(session_id, reply); } catch {} }

    return sendJson(res, { ok:true, reply, source: llm.ok ? 'openai':'fallback', isLocal }, 200, CORS);

  } catch(e) {
    // Ultime retour (évite silences)
    return sendJson(res, { ok:true, reply: fallbackReply(''), source:'hard-fallback', isLocal:true, error:String(e?.message||e) }, 200, CORS);
  }
}
