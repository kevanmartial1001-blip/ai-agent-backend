// api/chat.js
export const config = { runtime: 'nodejs' };

const KB_BASE = () => process.env.KB_BASE;
const KB_TOKEN = () => process.env.KB_TOKEN;
const HG = 'https://api.heygen.com/v1';

function corsHeaders(req){
  const allow = (process.env.CORS_ORIGINS || '*').split(',').map(s=>s.trim()).filter(Boolean);
  const origin = req.headers.get?.('origin') || '';
  const ok = allow.includes('*') || allow.includes(origin);
  return {
    'access-control-allow-origin': ok ? (allow.includes('*') ? '*' : origin) : 'null',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization'
  };
}
const json = (d, s=200, h={}) => new Response(JSON.stringify(d), { status:s, headers:{...h, 'content-type':'application/json'} });

async function kbGet(r, params){
  const qs = new URLSearchParams({ ...params, r, token: KB_TOKEN() }).toString();
  const res = await fetch(`${KB_BASE()}?${qs}`, { cache:'no-store' });
  const d = await res.json(); if(!d.ok) throw new Error(d.error||'KB error'); return d.data;
}
async function kbPost(r, body){
  const res = await fetch(`${KB_BASE()}?r=${r}&token=${KB_TOKEN()}`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body||{}) });
  const d = await res.json(); if(!d.ok) throw new Error(d.error||'KB post error'); return true;
}
async function heygenSay(session_id, text){
  try{
    await fetch(`${HG}/streaming.task`, {
      method:'POST',
      headers:{ 'X-Api-Key': process.env.HEYGEN_API_KEY, 'content-type':'application/json' },
      body: JSON.stringify({ session_id, text, task_type:'repeat', task_mode:'sync' })
    });
  }catch(_e){/* on ne plante pas si TTS échoue */}
}

const MINI_PROMPT = [
  "You are Kevin’s AI sales consultant. Strict 6-step script: intro → AI familiarity → tailored examples → discovery → 2–3 agent recommendations → CTA for a personalized demo.",
  "Continue from context; do NOT repeat previous lines. Reply <= 160 words. Default English; fully switch to user language if detected (French = metropolitan).",
  "Respect GEO redlines if provided. OUTPUT JSON ONLY: {\"reply\":\"...\",\"state\":{\"industry_id\":\"...\",\"role_level\":\"CEO|C_SUITE|MANAGEMENT|EMPLOYEES|unknown\",\"country\":\"\",\"subregion\":\"\",\"captured_problems\":[],\"query_tags\":[],\"language_guess\":\"\"}}"
].join(' ');

// Appel OpenAI avec timeout + gestion d’erreur souple
async function llmReply(messages){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), 12000); // 12s
  try{
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{ 'authorization':'Bearer '+process.env.OPENAI_API_KEY, 'content-type':'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature:0.3, max_tokens:320, messages }),
      signal: controller.signal
    });
    const txt = await r.text(); let body = {};
    try{ body = JSON.parse(txt); }catch{}
    if(!r.ok) throw new Error(body?.error?.message || txt);
    const content = body?.choices?.[0]?.message?.content || '';
    return { ok:true, content };
  }catch(e){
    return { ok:false, error: String(e?.message||e) };
  }finally{
    clearTimeout(timer);
  }
}

// Réponse de secours si LLM HS
function fallbackReply(userText){
  const t = (userText||'').slice(0,200);
  return `Quick answer: I heard “${t}”. I’m having a brief connection issue. Let me keep things moving — could you tell me your industry and your role?`;
}

export default async function handler(req){
  const CORS = corsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status:204, headers:CORS });

  try{
    const { session_id, visitor_id, text, lang } = await req.json();
    if(!session_id || !text) return json({ ok:false, error:'missing params' }, 400, CORS);

    // 1) log user
    await kbPost('logturn', { session_id, visitor_id, role:'user', text, lang: lang||'' });

    // 2) history (court) + KB (pack minimal)
    let inferredIndustry = 'universal_business', roleLevel='unknown', country='', subregion='';
    const history = await kbGet('history', { session_id, limit:'8' });

    const [industry, persona, geo, scenarios] = await Promise.all([
      kbGet('industry', { industry_id: inferredIndustry }),
      kbGet('persona',  { industry_id: inferredIndustry, level: roleLevel }),
      kbGet('geo',      { industry_id: inferredIndustry, country, subregion }),
      kbGet('scenarios',{ industry_id: inferredIndustry, q: (industry?.key_pains||[]).slice(0,3).join(' '), tags:'lead intake;ops', limit:'2' })
    ]);

    const lines = (label, arr) => (arr && arr.length) ? `- ${label}: ${arr.slice(0,3).join('; ')}` : '';
    const kbPack = [
      `KB PACK:`,
      `INDUSTRY: ${industry.industry_id}`,
      lines('key_pains', industry.key_pains),
      lines('success_metrics', industry.success_metrics),
      `PERSONA: ${persona.level}`,
      lines('goals_metrics', persona.goals_metrics),
      lines('hot_buttons', persona.hot_buttons),
      `GEO: ${geo.country||''}${geo.subregion?(', '+geo.subregion):''}`,
      lines('mandatory_disclosures', geo.mandatory_disclosures),
      lines('redlines', geo.redlines),
      `SCENARIOS:`,
      ...(scenarios||[]).map((s,i)=>`  ${i+1}) ${s.agent_name}: ${s.how_it_works}`)
    ].filter(Boolean).join('\n');

    const toMsgs = arr => arr.map(t => ({ role: t.role==='assistant'?'assistant':'user', content: t.text })).slice(-8);
    const messages = [
      { role:'system', content: MINI_PROMPT },
      { role:'system', content: kbPack },
      ...toMsgs(history),
      { role:'user', content: String(text) }
    ];

    // 3) LLM
    const llm = await llmReply(messages);
    let reply = '';
    if (llm.ok) {
      // on attend un JSON {"reply":"..."}
      try {
        const parsed = JSON.parse(llm.content);
        reply = String(parsed?.reply || '');
      } catch {
        reply = String(llm.content || '');
      }
    } else {
      reply = fallbackReply(text);
    }
    if (!reply) reply = fallbackReply(text);

    // 4) log assistant + parler
    await kbPost('logturn', { session_id, visitor_id, role:'assistant', text: reply, lang: lang||'' });
    await heygenSay(session_id, reply);

    // 5) retour client
    return json({ ok:true, reply, source: llm.ok ? 'openai' : 'fallback', error: llm.ok ? undefined : llm.error }, 200, CORS);
  }catch(e){
    // même en cas d’erreur globale, on retourne un 200 avec un message de secours pour que l’avatar parle
    const bodyTxt = fallbackReply('');
    const { session_id } = (()=>{ try{ return JSON.parse((await req.text())||'{}'); }catch{ return {}; } })();
    if (session_id) await heygenSay(session_id, bodyTxt).catch(()=>{});
    return json({ ok:true, reply: bodyTxt, source:'hard-fallback', error:String(e?.message||e) }, 200, CORS);
  }
}
