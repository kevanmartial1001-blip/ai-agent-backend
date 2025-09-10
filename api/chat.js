// api/chat.js  — Node.js serverless (CORS + fallbacks + "local-" sessions)
export const config = { runtime: 'nodejs' };

const HG = 'https://api.heygen.com/v1';

function getCorsHeaders(req) {
  const allow = (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
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
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8') || '';
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

// ---- KB helpers (Apps Script /exec) ----
const KB_BASE = () => process.env.KB_BASE;
const KB_TOKEN = () => process.env.KB_TOKEN;

async function kbGet(route, params) {
  const qs = new URLSearchParams({ ...params, r: route, token: KB_TOKEN() }).toString();
  const url = `${KB_BASE()}?${qs}`;
  const r = await fetch(url, { cache: 'no-store' });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || `KB GET ${route} error`);
  return d.data;
}
async function kbPost(route, body) {
  const url = `${KB_BASE()}?r=${route}&token=${KB_TOKEN()}`;
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || `KB POST ${route} error`);
  return true;
}

// ---- HeyGen speak ----
async function heygenSay(session_id, text) {
  try {
    await fetch(`${HG}/streaming.task`, {
      method: 'POST',
      headers: { 'X-Api-Key': process.env.HEYGEN_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ session_id, text, task_type: 'repeat', task_mode: 'sync' })
    });
  } catch { /* swallow */ }
}

// ---- LLM prompt (compact) ----
const MINI_PROMPT = [
  "You are Kevin’s AI sales consultant. Strict 6-step script: intro → AI familiarity → tailored examples → discovery → 2–3 agent recommendations → CTA for a personalized demo.",
  "Continue from context; do NOT repeat previous lines. Reply <= 160 words. Default English; fully switch to user language if detected (French = metropolitan).",
  "Respect GEO redlines if provided. OUTPUT JSON ONLY: {\"reply\":\"...\",\"state\":{\"industry_id\":\"...\",\"role_level\":\"CEO|C_SUITE|MANAGEMENT|EMPLOYEES|unknown\",\"country\":\"\",\"subregion\":\"\",\"captured_problems\":[],\"query_tags\":[],\"language_guess\":\"\"}}"
].join(' ');

// ---- OpenAI call with timeout ----
async function llmReply(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + process.env.OPENAI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature: 0.3, max_tokens: 320, messages }),
      signal: controller.signal
    });
    const txt = await r.text();
    let body = {}; try { body = JSON.parse(txt); } catch {}
    if (!r.ok) throw new Error(body?.error?.message || txt);
    const content = body?.choices?.[0]?.message?.content || '';
    return { ok: true, content };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function fallbackReply(userText) {
  const t = (userText || '').slice(0, 180);
  return `Quick heads-up: I heard “${t}”. I had a small connection hiccup. Let me keep things moving — could you tell me your industry and your role?`;
}

export default async function handler(req, res) {
  const CORS = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    return res.end();
  }

  try {
    const body = await parseBody(req);
    let { session_id, visitor_id, text, lang } = body || {};
    if (!text) return sendJson(res, { ok: false, error: 'missing text' }, 400, CORS);

    // Autoriser les "sessions locales" (fallback audio-only)
    if (!session_id) session_id = 'local-' + Math.random().toString(36).slice(2);
    const isLocal = String(session_id).startsWith('local-');

    // Log user turn
    await kbPost('logturn', { session_id, visitor_id, role: 'user', text, lang: lang || '' });

    // KB pack minimal + historique court
    let inferredIndustry = 'universal_business', roleLevel = 'unknown', country = '', subregion = '';
    const history = await kbGet('history', { session_id, limit: '8' });
    const [industry, persona, geo, scenarios] = await Promise.all([
      kbGet('industry', { industry_id: inferredIndustry }),
      kbGet('persona', { industry_id: inferredIndustry, level: roleLevel }),
      kbGet('geo', { industry_id: inferredIndustry, country, subregion }),
      kbGet('scenarios', { industry_id: inferredIndustry, q: (industry?.key_pains || []).slice(0, 3).join(' '), tags: 'lead intake;ops', limit: '2' })
    ]);

    const lines = (label, arr) => (arr && arr.length) ? `- ${label}: ${arr.slice(0, 3).join('; ')}` : '';
    const kbPack = [
      `KB PACK:`,
      `INDUSTRY: ${industry.industry_id}`,
      lines('key_pains', industry.key_pains),
      lines('success_metrics', industry.success_metrics),
      `PERSONA: ${persona.level}`,
      lines('goals_metrics', persona.goals_metrics),
      lines('hot_buttons', persona.hot_buttons),
      `GEO: ${geo.country || ''}${geo.subregion ? (', ' + geo.subregion) : ''}`,
      lines('mandatory_disclosures', geo.mandatory_disclosures),
      lines('redlines', geo.redlines),
      `SCENARIOS:`,
      ...(scenarios || []).map((s, i) => `  ${i + 1}) ${s.agent_name}: ${s.how_it_works}`)
    ].filter(Boolean).join('\n');

    const toMsgs = arr => arr.map(t => ({ role: t.role === 'assistant' ? 'assistant' : 'user', content: t.text })).slice(-8);
    const messages = [
      { role: 'system', content: MINI_PROMPT },
      { role: 'system', content: kbPack },
      ...toMsgs(history),
      { role: 'user', content: String(text) }
    ];

    // LLM
    const llm = await llmReply(messages);
    let reply = '';
    if (llm.ok) {
      try { const parsed = JSON.parse(llm.content); reply = String(parsed?.reply || ''); }
      catch { reply = String(llm.content || ''); }
    } else {
      reply = fallbackReply(text);
    }
    if (!reply) reply = fallbackReply(text);

    // Log assistant
    await kbPost('logturn', { session_id, visitor_id, role: 'assistant', text: reply, lang: lang || '' });

    // Parler uniquement si ce n'est pas une session locale
    if (!isLocal) await heygenSay(session_id, reply);

    return sendJson(res, { ok: true, reply, source: llm.ok ? 'openai' : 'fallback', isLocal }, 200, CORS);

  } catch (e) {
    // Hard fallback
    try {
      const body = await parseBody(req);
      const sid = body?.session_id || ('local-' + Math.random().toString(36).slice(2));
      const msg = fallbackReply(body?.text || '');
      // pas d'appel HeyGen si local
      await kbPost('logturn', { session_id: sid, visitor_id: body?.visitor_id, role: 'assistant', text: msg, lang: body?.lang || '' });
      return sendJson(res, { ok: true, reply: msg, source: 'hard-fallback', isLocal: true, error: String(e?.message || e) }, 200, CORS);
    } catch {
      return sendJson(res, { ok: false, error: String(e?.message || e) }, 500, CORS);
    }
  }
}
