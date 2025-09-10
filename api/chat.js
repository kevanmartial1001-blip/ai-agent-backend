export const config = { runtime: 'edge' };
const KB_BASE = () => process.env.KB_BASE;
const KB_TOKEN = () => process.env.KB_TOKEN;
const HG='https://api.heygen.com/v1';
const json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json','access-control-allow-origin':'*'}});

async function kbGet(r, params){
  const qs = new URLSearchParams({ ...params, r, token: KB_TOKEN() }).toString();
  const url = `${KB_BASE()}?${qs}`;
  const res = await fetch(url, { cache: 'no-store' });
  const d = await res.json(); if(!d.ok) throw new Error(d.error||'KB error');
  return d.data;
}
async function kbPost(r, body){
  const url = `${KB_BASE()}?r=${r}&token=${KB_TOKEN()}`;
  const res = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body||{}) });
  const d = await res.json(); if(!d.ok) throw new Error(d.error||'KB post error');
  return true;
}
async function heygenSay(session_id, text){
  await fetch(`${HG}/streaming.task`, {
    method:'POST',
    headers:{'X-Api-Key':process.env.HEYGEN_API_KEY,'content-type':'application/json'},
    body: JSON.stringify({ session_id, text, task_type:'repeat', task_mode:'sync' })
  });
}
const MINI_PROMPT = [
  "You are Kevin’s AI sales consultant. Strict 6-step script: intro → AI familiarity → tailored examples → discovery → 2–3 agent recommendations → CTA for a personalized demo.",
  "Continue from context; do NOT repeat previous lines. Reply <= 160 words. Default English; fully switch to user language if detected (French = metropolitan).",
  "Respect GEO redlines if provided. OUTPUT JSON ONLY: {\"reply\":\"...\",\"state\":{\"industry_id\":\"...\",\"role_level\":\"CEO|C_SUITE|MANAGEMENT|EMPLOYEES|unknown\",\"country\":\"\",\"subregion\":\"\",\"captured_problems\":[],\"query_tags\":[],\"language_guess\":\"\"}}"
].join(' ');

export default async function handler(req){
  if (req.method==='OPTIONS') return json({},204);
  const { session_id, visitor_id, text, lang } = await req.json();
  if (!session_id || !text) return json({ ok:false, error:'missing params' }, 400);

  // 1) log user turn
  await kbPost('logturn', { session_id, visitor_id, role:'user', text, lang: lang||'' });

  // 2) recent history
  const history = await kbGet('history', { session_id, limit:'8' });

  // 3) (v1) inferred minimal context — on raffinera
  let inferredIndustry = 'universal_business', roleLevel='unknown', country='', subregion='';

  // 4) compact KB pack
  const industry = await kbGet('industry', { industry_id: inferredIndustry });
  const persona  = await kbGet('persona',  { industry_id: inferredIndustry, level: roleLevel });
  const geo      = await kbGet('geo',      { industry_id: inferredIndustry, country, subregion });
  const scenarios= await kbGet('scenarios',{ industry_id: inferredIndustry, q: (industry.key_pains||[]).slice(0,3).join(' '), tags:'lead intake;ops', limit:'2' });

  function lines(label, arr){ return (arr && arr.length) ? `- ${label}: ${arr.slice(0,3).join('; ')}` : ''; }
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

  // 5) messages
  const toMsgs = arr => arr.map(t => ({ role: t.role==='assistant'?'assistant':'user', content: t.text })).slice(-8);
  const messages = [{ role:'system', content: MINI_PROMPT }, { role:'system', content: kbPack }, ...toMsgs(history), { role:'user', content: String(text) }];

  // 6) OpenAI
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method:'POST',
    headers:{ 'authorization':'Bearer '+process.env.OPENAI_API_KEY, 'content-type':'application/json' },
    body: JSON.stringify({ model:'gpt-4o-mini', temperature:0.3, max_tokens:320, messages })
  });
  const t = await r.text(); let body={}; try{ body=JSON.parse(t);}catch{}
  if (!r.ok) return json({ ok:false, error:t }, r.status);
  const content = body?.choices?.[0]?.message?.content || '';
  let out = {}; try{ out = JSON.parse(content); }catch(_){ out = { reply: content, state: { industry_id: inferredIndustry, role_level: roleLevel, country, subregion, captured_problems:[], query_tags:[], language_guess: lang||'' } }; }

  // 7) log assistant & say
  await kbPost('logturn', { session_id, visitor_id, role:'assistant', text: out.reply||'', lang: out?.state?.language_guess||'' });
  await heygenSay(session_id, out.reply||'');

  return json({ ok:true, reply: out.reply||'' });
}
