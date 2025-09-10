// api/chat.js — Node.js serverless, fast-paths + latence réduite
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

// ---- KB helpers ----
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

// ---- LLM (timeout court) ----
async function llmReply(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000); // 6s
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{ 'authorization':'Bearer '+process.env.OPENAI_API_KEY, 'content-type':'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature:0.2, max_tokens:200, messages }),
      signal: controller.signal
    });
    const txt = await r.text();
    let body={}; try{ body=JSON.parse(txt);}catch{}
    if(!r.ok) throw new Error(body?.error?.message || txt);
    const content = body?.choices?.[0]?.message?.content || '';
    return { ok:true, content };
  } catch(e) { return { ok:false, error:String(e?.message||e) }; }
  finally { clearTimeout(timer); }
}

const MINI_PROMPT = [
  "You are Kevin’s AI sales consultant. Follow this strict flow: intro → AI familiarity → tailored examples → discovery → 2–3 agent recommendations → CTA.",
  "Never repeat the user verbatim. Keep <= 90 words. Warm, concise, concrete.",
  "If off-track: brief answer, then return to current step."
].join(' ');

function fallbackReply(userText) {
  const t = (userText||'').slice(0,120);
  return `Thanks! Let’s keep moving — what industry are you in, and what’s your role?`;
}

// ---- Fast-paths (pas d’appel LLM) ----
const yesHearRe = /(yes|yeah|yep|i\s*can\s*hear|i\s*hear\s*you)/i;
const seeRe     = /(i\s*can\s*see|see\s*you)/i;
const followRe  = /\bfollow[-\s]?up\b/i;

function fastPath(text){
  const s = (text||'').trim();
  if (!s) return null;

  // “Oui j’entends / je te vois” -> passe direct à la qualification
  if (yesHearRe.test(s) || seeRe.test(s)) {
    return "Perfect. To tailor this for you: which industry are you in, and what's your role?";
  }

  // Mot-clé “follow-up” -> recommandations instantanées
  if (followRe.test(s)) {
    return [
      "Follow-up is where teams win or lose deals. Two quick options:",
      "• CRM Hygiene & Follow-Up Agent — keeps pipeline clean, nudges you with next actions, auto-drafts replies in your tone.",
      "• Scheduling Concierge Agent — proposes slots, sends polite nudges, books meetings.",
      "Which fits better right now?"
    ].join(' ');
  }

  // Petites réponses d’acquittement
  if (s.split(/\s+/).length <= 3 && /^(ok|okay|sure|fine|great|cool)$/i.test(s)) {
    return "Great — quick context: which industry are you in, and what’s your role?";
  }

  return null;
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

    // Mode audio-only si pas de session HeyGen
    if (!session_id) session_id = 'local-'+Math.random().toString(36).slice(2);
    const isLocal = String(session_id).startsWith('local-');

    // Log USER (best effort)
    try { await kbPost('logturn', { session_id, visitor_id, role:'user', text, lang: lang||'' }); } catch {}

    // 0) Fast-path immédiat si applicable
    const quick = fastPath(text);
    if (quick) {
      try { await kbPost('logturn', { session_id, visitor_id, role:'assistant', text: quick, lang: lang||'' }); } catch {}
      if (!isLocal) { try { await heygenSay(session_id, quick); } catch {} }
      return sendJson(res, { ok:true, reply: quick, source:'fast', isLocal }, 200, CORS);
    }

    // 1) KB minimal (robuste)
    let industry = { industry_id:'universal_business', key_pains:[], success_metrics:[] };
    try { const x = await kbGet('industry', { industry_id:'universal_business' }); industry = { ...industry, ...(x||{}) }; } catch {}

    // 2) Historique court
    let history=[]; try { history = await kbGet('history', { session_id, limit:'4' }); } catch {}

    // 3) Compose prompt concis
    const kbPack = [
      `INDUSTRY: ${industry.industry_id}`,
      industry.key_pains?.length ? `PAINS: ${industry.key_pains.slice(0,3).join('; ')}` : ''
    ].filter(Boolean).join('\n');

    const msgs = [
      { role:'system', content: MINI_PROMPT },
      { role:'system', content: kbPack },
      ...history.map(t=>({ role: t.role==='assistant'?'assistant':'user', content: t.text })),
      { role:'user', content: String(text) }
    ];

    // 4) LLM (6s max)
    const llm = await llmReply(msgs);
    let reply = '';
    if (llm.ok) {
      try { const parsed = JSON.parse(llm.content); reply = String(parsed?.reply || ''); }
      catch { reply = String(llm.content || ''); }
    }
    if (!reply) reply = fallbackReply(text);

    // 5) Log + parole
    try { await kbPost('logturn', { session_id, visitor_id, role:'assistant', text: reply, lang: lang||'' }); } catch {}
    if (!isLocal) { try { await heygenSay(session_id, reply); } catch {} }

    return sendJson(res, { ok:true, reply, source: llm.ok?'openai':'fallback', isLocal }, 200, CORS);

  } catch(e) {
    return sendJson(res, { ok:true, reply: fallbackReply(''), source:'hard-fallback', isLocal:true, error:String(e?.message||e) }, 200, CORS);
  }
}
