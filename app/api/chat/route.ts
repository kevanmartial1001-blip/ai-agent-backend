// File: app/api/chat/route.ts
// pnpm add openai ai  (ou npm/yarn)
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

// ---------- KB fetchers (Apps Script) ----------
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

// ---------- helpers ----------
function guessLocaleFromText(t?: string) {
  if (!t) return process.env.LANG_DEFAULT || 'en';
  const s = t.toLowerCase();
  if (/[àâçéèêëîïôùûüÿœ]/.test(s) || /bonjour|merci|industrie|parfait/.test(s)) return 'fr';
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
  if (/(first time|new to ai|just exploring|no idea|beginner|not familiar)/.test(s)) return 'newcomer';
  if (/(daily|every day|we use|already using|advanced|expert|fine-tuning|agents)/.test(s)) return 'advanced';
  return 'intermediate';
}
function deriveIntentKeywords(text?: string) {
  const s = (text||'').toLowerCase();
  const keys: string[] = ['automation','workflow','intake'];
  if (/sales|leads|crm|pipeline/.test(s)) keys.push('sales','leads','crm');
  if (/ops|operations|fulfillment|wms|logistics|inventory/.test(s)) keys.push('ops','wms','logistics','inventory');
  if (/support|tickets|zendesk|helpdesk|service/.test(s)) keys.push('support','tickets','service');
  if (/finance|invoice|billing|ap|ar|collections/.test(s)) keys.push('finance','invoice','billing','ap','ar','collections');
  return Array.from(new Set(keys)).join(',');
}
function hasStep1Minimum(state:any) {
  return !!(state?.industry?.industry_id && state?.role_level && state?.geo_country);
}

// ---------- ROUTE ----------
export async function POST(req: Request) {
  const { session_id, user_text = '', state = {}, hints = {}, language } = await req.json();
  const lang = language || guessLocaleFromText(user_text);
  const current = state.current_step || 'step1_intro';

  // ---- try enrich step1 slots if missing ----
  let industry: KBIndustry | null = state.industry || null;
  if (!industry && user_text) {
    try { industry = await kbIndustryMatch(user_text); } catch {}
  }
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
  }

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
    // classify and prefetch scenarios
    const ai_exp = classifyAIExperience(user_text);
    const q = deriveIntentKeywords(user_text) || 'intro,intake,automation';
    let scenarios: KBScenario[] = [];
    try {
      if (industry?.industry_id) {
        const res = await kbSearchScenarios(industry.industry_id, q, 6);
        scenarios = res.snippets || [];
      }
    } catch {}
    const scenarioHints = scenarios.slice(0,2).map((s,i)=> `${i+1}. ${s.agent_name}`).join(' • ');

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
Classify ai_experience from user's last message: newcomer|intermediate|advanced.
Preload scenarios (max 6). Example agents (tease only): ${scenarioHints || 'TBD'}.
Rules:
- If newcomer, propose “two very simple examples”.
- If advanced, propose “two industry-specific examples”.
- End with one question that sets up Step 3 (examples preference).`.trim();
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
    // keep classification handy for Step 3
    ai_experience: nextStep === 'step2_ai_fam' ? classifyAIExperience(user_text) : (state.ai_experience || null),
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
