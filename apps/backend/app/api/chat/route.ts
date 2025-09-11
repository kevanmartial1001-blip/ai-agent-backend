// File: app/api/chat/route.ts
// Runtime: Vercel Edge
// Deps: pnpm add openai ai
// ENV: OPENAI_API_KEY, KB_SHEETS_URL, KB_TOKEN, (opt) LANG_DEFAULT

import { OpenAI } from 'openai';
import { OpenAIStream, StreamingTextResponse } from 'ai';

export const runtime = 'edge';

type KBIndustry = { industry_id: string; industry_name: string; key_pains?: string[]; jargon?: string[]; };
type KBPersona  = { persona_id?: string; tone_formality?: string; proof_ratio?: string; idioms_preferred?: string; };
type KBGeo      = { must_ask_qualifying_questions?: string[]; redlines?: string[]; agent_prompt?: string; local_integrations?: string[]; };
type KBScenario = {
  scenario_id: string; industry_id: string; agent_name: string;
  actual_situation: string; problem: string; narrative: string;
  how_it_works: string; tags?: string[]; roi_hypothesis?: string;
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

/* ---------------- KB fetchers (Apps Script) ---------------- */
async function kbGET(params: Record<string,string>): Promise<any> {
  const url = new URL(process.env.KB_SHEETS_URL!);
  url.searchParams.set('token', process.env.KB_TOKEN!);
  for (const [k,v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), { cache: 'no-store' });
  if (!r.ok) throw new Error('KB request failed: ' + r.status);
  return await r.json();
}
const kbIndustryMatch = (text: string) => kbGET({ fn: 'industry_match', text: text||'' }) as Promise<KBIndustry>;
const kbPersona       = (industry_id: string, role_level?: string, locale?: string) => kbGET({
  fn: 'persona', industry_id, role_level: role_level||'', locale: locale||''
}) as Promise<KBPersona>;
const kbGeo           = (industry_id: string, country: string, state?: string) => kbGET({
  fn: 'geo', industry_id, country, state: state||''
}) as Promise<KBGeo>;
const kbSearchScenarios = (industry_id: string, q: string, limit=6) => kbGET({
  fn: 'search_scenarios', industry_id, q, limit: String(limit)
}) as Promise<{ snippets: KBScenario[] }>;

/* ---------------- helpers ---------------- */
function guessLocaleFromText(t?: string) {
  if (!t) return process.env.LANG_DEFAULT || 'en';
  const s = t.toLowerCase();
  if (/[àâçéèêëîïôùûüÿœ]/.test(s) || /bonjour|merci|industrie|parfait|poste|localisation/.test(s)) return 'fr';
  if (/[áéíóúñü]/.test(s) || /hola|gracias|industria/.test(s)) return 'es';
  return process.env.LANG_DEFAULT || 'en';
}
function normalizeRoleLevel(text?: string): string|undefined {
  if (!text) return;
  const t = text.toLowerCase();
  if (/(^|[^a-z])(ceo|owner|founder)([^a-z]|$)/.test(t)) return 'CEO';
  if (/(c[-\s]?suite|cto|cfo|coo|cmo|cio)/.test(t)) return 'C_SUITE';
  if (/(manager|head|lead|director)/.test(t)) return 'MANAGEMENT';
  if (/(agent|rep|assistant|associate|staff|employee)/.test(t)) return 'EMPLOYEES';
  return undefined;
}
function classifyAIExperience(text?: string) {
  const s = (text||'').toLowerCase();
  if (/(first time|new to ai|just exploring|no idea|beginner|not familiar|découverte|débutant)/.test(s)) return 'newcomer';
  if (/(daily|every day|we use|already using|advanced|expert|fine-tuning|agents|quotidiennement|déjà|avancé)/.test(s)) return 'advanced';
  return 'intermediate';
}
function deriveIntentKeywords(text?: string) {
  const s = (text||'').toLowerCase();
  const keys: string[] = ['automation','workflow','intake'];
  if (/sales|leads|crm|pipeline|vente|prospect/.test(s)) keys.push('sales','leads','crm');
  if (/ops|operations|fulfillment|wms|logistics|inventory|logistique|inventaire/.test(s)) keys.push('ops','wms','logistics','inventory');
  if (/support|tickets|zendesk|helpdesk|service|sav/.test(s)) keys.push('support','tickets','service');
  if (/finance|invoice|billing|ap|ar|collections|facture|compta/.test(s)) keys.push('finance','invoice','billing','ap','ar','collections');
  return Array.from(new Set(keys)).join(',');
}
function hasStep1Minimum(x:any) {
  return !!(x?.industry?.industry_id && x?.role_level && x?.geo_country);
}
function trunc(s: string, n=160) {
  if (!s) return '';
  const t = s.trim().replace(/\s+/g,' ');
  return t.length > n ? t.slice(0, n-1) + '…' : t;
}
function positiveSignalScore(text?: string) {
  const s = (text||'').toLowerCase();
  const hits = [
    'yes','ok','sure','go ahead','proceed','interested','let’s do it','let us do it','sounds good','sounds great',
    'amazing','impressed','show me','demo','on board','partant','intéressé','ça me va','parfait','allons-y','go'
  ];
  return hits.reduce((acc,h)=> acc + (s.includes(h) ? 1 : 0), 0);
}
function extractContact(text?: string) {
  const s = text || '';
  const email = s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)?.[0] || '';
  const website = s.match(/\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+/gi)?.[0] || '';
  const phone = s.match(/(\+?\d[\d\s\-().]{6,}\d)/g)?.[0] || '';
  const company = s.match(/\b(company|co\.|s\.a\.|s\.l\.|ltd|llc|inc)\b/i) ? s : '';
  return { email, website, whatsapp: phone, company: company ? s : '' };
}

/* ---------------- route ---------------- */
export async function POST(req: Request) {
  const { session_id, user_text = '', state = {}, hints = {}, language } = await req.json();
  const lang = language || guessLocaleFromText(user_text);
  const current = state.current_step || 'step1_intro';

  // ---- enrich Step 1 slots if missing ----
  let industry: KBIndustry | null = state.industry || null;
  if (!industry && user_text) { try { industry = await kbIndustryMatch(user_text); } catch {} }
  const role_level = state.role_level || normalizeRoleLevel(user_text) || hints.role_level || null;
  const geo_country = state.geo_country || hints.geo_country || null;
  const geo_state   = state.geo_state   || hints.geo_state   || null;

  let persona: KBPersona | null = state.persona || null;
  let geo: KBGeo | null = state.geo || null;
  if (industry && (role_level || geo_country)) {
    try { if (!persona && role_level) persona = await kbPersona(industry.industry_id, role_level, lang); } catch {}
    try { if (!geo && geo_country)    geo     = await kbGeo(industry.industry_id, geo_country, geo_state||undefined); } catch {}
  }

  // ---- step routing ----
  let nextStep = current;
  if (current === 'step1_intro' && hasStep1Minimum({ industry, role_level, geo_country })) {
    nextStep = 'step2_ai_fam';
  } else if (current === 'step2_ai_fam') {
    nextStep = 'step3_building_ground';
  } else if (current === 'step3_building_ground') {
    nextStep = 'step4_discovery';
  } else if (current === 'step4_discovery') {
    nextStep = 'step5_selection';
  } else if (current === 'step5_selection') {
    nextStep = 'step6_cta';
  }

  // ---- prefetch scenarios when entering Step 2/3/4/5 ----
  let preScenarios: KBScenario[] = state.preScenarios || [];
  if ((nextStep === 'step2_ai_fam' || nextStep === 'step3_building_ground' || nextStep === 'step4_discovery' || nextStep === 'step5_selection') && industry?.industry_id) {
    const q = deriveIntentKeywords(user_text) || 'intro,intake,automation';
    try {
      const res = await kbSearchScenarios(industry.industry_id, q, 8);
      preScenarios = res.snippets || [];
    } catch {}
  }

  // ---- discovery + selection helpers ----
  const commonProblems = Array.from(new Set(preScenarios.map(s => trunc(s.problem, 120)).filter(Boolean))).slice(0, 3);
  // for selection, pick best 2–3 agents
  const selectedAgents = preScenarios.slice(0, 3);

  // ---- CTA helpers ----
  const buySignals = (state.buySignals || 0) + positiveSignalScore(user_text);
  const contactIn  = extractContact(user_text);
  const contact    = {
    company: state.contact?.company || contactIn.company || '',
    website: state.contact?.website || contactIn.website || '',
    email:   state.contact?.email   || contactIn.email   || '',
    whatsapp:state.contact?.whatsapp|| contactIn.whatsapp|| '',
    prefer:  state.contact?.prefer  || (/\bwhats(app)?\b/i.test(user_text) ? 'whatsapp' : (/\bemail|mail\b/i.test(user_text) ? 'email' : ''))
  };
  const contactComplete = !!(contact.email || contact.whatsapp) && !!contact.website;

  // ---- build prompts per step ----
  let SYSTEM = '';
  let DEV = '';

  if (nextStep === 'step1_intro') {
    SYSTEM = `
You are “Alex”, AI Sales Consultant. STEP 1 ONLY.
- Greet, confirm AV.
- Capture industry, role, country (if USA, ask state).
- If industry known, mirror ONE key pain (don't invent).
- ≤7 sentences, simple words. Ask EXACTLY ONE question at the end.
Language: ${lang}.`.trim();

    DEV = `
STATE: step1_intro
Industry: ${industry?.industry_name ?? 'unknown'}
Key pains: ${(industry?.key_pains||[]).slice(0,3).join(', ') || 'n/a'}
Role level: ${role_level ?? 'unknown'}
Geo: ${geo_country ?? 'unknown'}${geo_state ? ', '+geo_state : ''}
Rules:
- If info already given, do NOT re-ask—acknowledge and ask only what's missing.
- If USA detected and state missing, ask for state.
- End with one question to progress capture.`.trim();

  } else if (nextStep === 'step2_ai_fam') {
    const scenarioHints = preScenarios.slice(0,2).map((s,i)=> `${i+1}. ${s.agent_name}`).join(' • ');
    SYSTEM = `
You are “Alex”, AI Sales Consultant. STEP 2 ONLY (AI familiarity).
- Ask how familiar they are with AI (newcomer vs advanced).
- Prime 1–2 short, industry-specific example options ready for Step 3.
- ≤7 sentences, bullet-friendly. One question at end.
Language: ${lang}.`.trim();

    DEV = `
STATE: step2_ai_fam
Industry: ${industry?.industry_name ?? 'unknown'}
Role level: ${role_level ?? 'unknown'}
Geo: ${geo_country ?? 'unknown'}${geo_state ? ', '+geo_state : ''}
Scenarios (tease only): ${scenarioHints || 'TBD'}
Rules:
- If newcomer, propose “two very simple examples”.
- If advanced, propose “two industry-specific examples”.
- End with one question that sets up Step 3 (examples preference).`.trim();

  } else if (nextStep === 'step3_building_ground') {
    const ai_exp = state.ai_experience || classifyAIExperience(user_text);
    const top2 = preScenarios.slice(0, 2).map((s, i) => (
      `#${i+1} ${s.agent_name}\n` +
      `Actual: ${trunc(s.actual_situation)}\n` +
      `Problem: ${trunc(s.problem)}\n` +
      `How: ${trunc(s.how_it_works)}\n` +
      `After: ${trunc(s.narrative)}`
    )).join('\n---\n');

    SYSTEM = `
You are “Alex”, AI Sales Consultant. STEP 3 ONLY (Building Ground).
- If newcomer: give two very simple general examples, then ask to move to industry-specific.
- If advanced: present two industry-specific examples using KB snippets.
- Use structure: Actual → Problem → Agent → How it works → Life after. 
- ≤7 sentences total; one question at end.
Language: ${lang}.`.trim();

    DEV = `
STATE: step3_building_ground
AI experience: ${ai_exp}
Industry: ${industry?.industry_name ?? 'unknown'}
ROLE: ${role_level ?? 'unknown'}  GEO: ${geo_country ?? 'unknown'}${geo_state ? ', '+geo_state : ''}
KB EXAMPLES (paraphrase concisely; don't dump raw text):
${top2 || 'N/A'}
Rules:
- Do NOT invent facts; only use KB content for specifics.
- Keep two examples max; concise bullets allowed.
- End by asking permission to tailor to their stack and volumes.`.trim();

  } else if (nextStep === 'step4_discovery') {
    SYSTEM = `
You are “Alex”, AI Sales Consultant. STEP 4 ONLY (Discovery).
- Ask them to walk through a typical day and pinpoint the single most impactful area to improve.
- Use 2–3 industry-common problems from KB as mirrors (do not invent).
- ≤7 sentences; one clear question at end.
Language: ${lang}.`.trim();

    DEV = `
STATE: step4_discovery
Industry: ${industry?.industry_name ?? 'unknown'}
Common problems (from KB): ${commonProblems.join(' • ') || 'TBD'}
Rules:
- Ask 2–3 short second-level questions (manual vs automated; handoffs; approvals).
- Mirror 1–2 plausible pains (from KB problems) and confirm.
- End with: “Are some of these also happening for you?”.
- Do NOT propose solutions yet; Step 5 will do agent selection.`.trim();

  } else if (nextStep === 'step5_selection') {
    // Prepare up to 3 agents to present
    const top3 = selectedAgents.slice(0, 3).map((s, i) => (
      `#${i+1} ${s.agent_name}\n` +
      `Actual: ${trunc(s.actual_situation)}\n` +
      `Problem: ${trunc(s.problem)}\n` +
      `How: ${trunc(s.how_it_works)}\n` +
      `After: ${trunc(s.narrative)}\n` +
      (s.roi_hypothesis ? `ROI: ${trunc(s.roi_hypothesis, 100)}` : '')
    )).join('\n---\n');

    SYSTEM = `
You are “Alex”, AI Sales Consultant. STEP 5 ONLY (Agent Selection).
- Propose 2–3 agents that directly map to declared pains.
- For each agent: Actual → Problem → Agent name → How it works → Life after.
- If ROI available, add a soft line (“teams like yours typically save …”).
- ≤7 sentences total; one check-in question at end.
Language: ${lang}.`.trim();

    DEV = `
STATE: step5_selection
Industry: ${industry?.industry_name ?? 'unknown'}
Selected agents (paraphrase concisely; don't dump raw text):
${top3 || 'N/A'}
Rules:
- Keep max 3 agents; each ≤ 5 bullets worth of content (concise).
- End with: “Want one more example, or shall I show exactly how this would work in your business?”`.trim();

  } else if (nextStep === 'step6_cta') {
    // Decide CTA wording based on buySignals and contact status
    const strongIntent = buySignals >= 3;
    const needContact = !contactComplete;

    SYSTEM = `
You are “Alex”, AI Sales Consultant. STEP 6 ONLY (CTA).
- Offer a personalized demo platform, low-pressure.
- If contact details are missing, ask them to TYPE legal company name, website, and email or WhatsApp.
- If they provided contact, confirm and ask delivery preference (email vs WhatsApp).
- Only propose booking two time options if there are ≥3 positive buying signals.
- ≤7 sentences; one question at end.
Language: ${lang}.`.trim();

    DEV = `
STATE: step6_cta
Buy signals score: ${buySignals}
Contact so far: email=${contact.email||'-'} website=${contact.website||'-'} whatsapp=${contact.whatsapp||'-'} prefer=${contact.prefer||'-'}
Rules:
- If contact incomplete, ask them to TYPE company + website + email/WhatsApp.
- If contact complete, confirm and ask delivery preference (email or WhatsApp).
- If ≥3 buying signals, propose: “Wednesday 10:00” or “Thursday 15:00 (your time)?”
- Keep it friendly, no pressure, and concise.`.trim();
  }

  const messages = [
    { role: 'system' as const, content: SYSTEM },
    { role: 'system' as const, content: DEV },
    { role: 'user'   as const, content: user_text }
  ];

  const rsp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    stream: true,
    temperature: 0.3,
    messages,
  });

  const nextState = {
    ...state,
    current_step: nextStep,
    industry: industry || null,
    role_level: role_level || null,
    geo_country: geo_country || null,
    geo_state: geo_state || null,
    persona: persona || null,
    geo: geo || null,
    lang,
    preScenarios,
    ai_experience: classifyAIExperience(user_text) || state.ai_experience || null,
    commonProblems,
    selectedAgents,
    buySignals,
    contact,
  };

  return new StreamingTextResponse(OpenAIStream(rsp), {
    headers: {
      'x-next-state': JSON.stringify(nextState),
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization',
    },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    },
  });
}
