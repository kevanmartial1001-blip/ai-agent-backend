/* app/api/chat/route.ts
   Flow guard + KB-light enrichment + streaming
   Requirements: NEXT_RUNTIME=edge, OPENAI_API_KEY, KB_BASE_URL (Apps Script/Web API)
*/
export const runtime = 'edge';

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ---- Types ----
type Step = 'INTRO'|'FAMILIARITY'|'BUILDING'|'DISCOVERY'|'SELECTION'|'CTA';
type RoleLevel = 'CEO'|'C_SUITE'|'MANAGEMENT'|'EMPLOYEES'|'UNKNOWN';

interface Slots {
  industry_text?: string;
  industry_id?: string;
  industry_name?: string;
  key_pain?: string;
  role_level?: RoleLevel | string;
  geo_country?: string;
  geo_state?: string;
  ai_experience?: 'newcomer'|'intermediate'|'advanced'|'unknown';
  problems?: string[];
  priorities?: string[];
  volumes?: string;
  persona_id?: string;
}

interface AgentState {
  step: Step;
  started_at?: number;   // epoch seconds
  turn?: number;         // # of exchanges
  signals?: number;      // buying signals
  slots: Slots;
}

// ---- Config (tunable) ----
const MIN_TURNS_BEFORE_CTA = 10;     // ~10 messages → ~7 minutes en live
const MIN_SECONDS_BEFORE_CTA = 420;  // 7 minutes
const MIN_SIGNALS = 3;

// ---- KB helpers (Apps Script / custom API) ----
// Attends un backend Google Apps Script avec endpoints simples.
// Adapte les routes si besoin (GET pour simplicité / edge).
const KB_BASE = process.env.KB_BASE_URL; // ex: "https://script.google.com/macros/s/XXX/exec"

async function kbIndustryMatch(q: string) {
  if (!KB_BASE || !q) return null;
  const url = `${KB_BASE}?fn=industry_match&q=${encodeURIComponent(q)}`;
  try { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) return null; return await r.json(); }
  catch { return null; }
}

async function kbPersonaGeo(industry_id?: string, role_level?: string, country?: string, state?: string) {
  if (!KB_BASE || !industry_id) return { persona: null, geo: null };
  const personaUrl = `${KB_BASE}?fn=persona&industry_id=${encodeURIComponent(industry_id)}&role=${encodeURIComponent(role_level||'')}`;
  const geoUrl     = `${KB_BASE}?fn=geo&industry_id=${encodeURIComponent(industry_id)}&country=${encodeURIComponent(country||'')}&state=${encodeURIComponent(state||'')}`;
  try {
    const [p, g] = await Promise.all([fetch(personaUrl), fetch(geoUrl)]);
    return {
      persona: p.ok ? await p.json() : null,
      geo:     g.ok ? await g.json() : null
    };
  } catch { return { persona: null, geo: null }; }
}

async function kbSearchScenarios(industry_id?: string, q?: string) {
  if (!KB_BASE || !industry_id) return [];
  const url = `${KB_BASE}?fn=scenarios&industry_id=${encodeURIComponent(industry_id)}&q=${encodeURIComponent(q||'')}&limit=6`;
  try { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) return []; return await r.json(); }
  catch { return []; }
}

// ---- State helpers ----
function nowSec() { return Math.floor(Date.now()/1000); }

function normalizeState(input: any): AgentState {
  const s: AgentState = {
    step: (input?.step as Step) || 'INTRO',
    started_at: typeof input?.started_at === 'number' ? input.started_at : nowSec(),
    turn: typeof input?.turn === 'number' ? input.turn : 0,
    signals: typeof input?.signals === 'number' ? input.signals : 0,
    slots: input?.slots || {}
  };
  return s;
}

function detectSignals(text: string): number {
  // simple heuristics → monte à MIN_SIGNALS après 2–3 confirmations
  const sigs = [
    /this is great|love this|awesome|perfect|we need this|let's do it|sounds good/i,
    /send (me )?a demo|free trial|try it/i,
    /book (a )?call|schedule|set up/i,
    /pricing|cost|how much/i
  ];
  return sigs.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
}

function updateSlotsFrom(text: string, slots: Slots): Slots {
  // ultra-light extraction (tu peux brancher un NER plus tard)
  if (!slots.geo_country) {
    const m = text.match(/\b(USA|United States|Canada|United Kingdom|UK|France|Germany|Spain|Australia|Singapore|UAE)\b/i);
    if (m) slots.geo_country = m[0].toUpperCase() === 'UK' ? 'United Kingdom' : m[0];
  }
  if (slots.geo_country && /USA|United States/i.test(slots.geo_country) && !slots.geo_state) {
    const st = text.match(/\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV)\b/);
    if (st) slots.geo_state = st[0];
  }
  if (!slots.role_level) {
    if (/CEO|founder|owner/i.test(text)) slots.role_level = 'CEO';
    else if (/C[-\s]?suite|CFO|COO|CTO|CMO/i.test(text)) slots.role_level = 'C_SUITE';
    else if (/manager|head of|director/i.test(text)) slots.role_level = 'MANAGEMENT';
    else if (/agent|rep|staff|employee/i.test(text)) slots.role_level = 'EMPLOYEES';
    else slots.role_level = 'UNKNOWN';
  }
  return slots;
}

function stepComplete(state: AgentState): boolean {
  const s = state.slots;
  switch (state.step) {
    case 'INTRO':
      return !!(s.industry_id || s.industry_text) && !!s.role_level && !!s.geo_country;
    case 'FAMILIARITY':
      return !!s.ai_experience && s.ai_experience !== 'unknown';
    case 'BUILDING':
      return true; // après au moins un exemple
    case 'DISCOVERY':
      return (s.problems && s.problems.length >= 1);
    case 'SELECTION':
      return true; // après avoir proposé 2–3 agents
    case 'CTA':
      return true;
  }
}

function nextStep(state: AgentState): Step {
  if (!stepComplete(state)) return state.step;
  const order: Step[] = ['INTRO','FAMILIARITY','BUILDING','DISCOVERY','SELECTION','CTA'];
  const idx = order.indexOf(state.step);
  return order[Math.min(idx+1, order.length-1)];
}

function eligibleForCTA(state: AgentState): boolean {
  const elapsed = nowSec() - (state.started_at || nowSec());
  const okTurns = (state.turn || 0) >= MIN_TURNS_BEFORE_CTA;
  const okTime  = elapsed >= MIN_SECONDS_BEFORE_CTA;
  const okSig   = (state.signals || 0) >= MIN_SIGNALS;
  const s = state.slots;
  const haveBasics = !!(s.industry_id || s.industry_text) && !!s.role_level && !!s.geo_country && (s.problems?.length || 0) >= 1;
  return okTurns && okTime && okSig && haveBasics;
}

// ---- System prompt builder ----
function buildSystemPrompt(state: AgentState, kb: {industry?: any, persona?: any, geo?: any, scenarios?: any[]}){
  const gateMsg = `
FLOW (strict, do not skip or reorder):
1) Intro → confirm AV, capture industry + role + country (state if USA). Acknowledge ONE pain.
2) AI familiarity (newcomer vs experienced).
3) Building → give 1–2 examples (general if unsure, else industry-specific).
4) Discovery → typical day, manual vs automated, where handoffs slow, confirm main challenge.
5) Selection → propose 2–3 agents (each: actual → problem → how it works → life-after).
6) CTA (personalized demo) → ONLY when the server says eligible. If asked early, acknowledge and continue the flow.

GUARDRAILS:
- NEVER offer a demo before STEP 6 and server eligibility.
- If the user insists early, say: “Great—we’ll set it up right after I tailor this to your context,” then continue.
- Use “typically”, “likely”, “teams like yours see…”. Avoid hard promises.

ALWAYS: 1 question at the end. 3–6 sentences per message. Mirror the user language.
`;

  const kbBits: string[] = [];
  if (kb.industry) {
    kbBits.push(`INDUSTRY: ${kb.industry.industry_name || kb.industry.industry_id}`);
    if (kb.industry.key_pains) kbBits.push(`Common pains: ${kb.industry.key_pains}`);
    if (kb.industry.jargon)    kbBits.push(`Jargon: ${kb.industry.jargon}`);
  }
  if (kb.geo) {
    if (kb.geo.governing_law) kbBits.push(`Geo rules hint: ${kb.geo.governing_law} / ${kb.geo.data_privacy_frameworks || ''}`.trim());
  }
  if (kb.scenarios?.length) {
    const top = kb.scenarios.slice(0,3).map((s:any) => `• ${s.agent_name}: ${s.actual_situation} → ${s.problem} → how: ${s.how_it_works} → life-after: ${s.narrative}`).join('\n');
    kbBits.push(`Candidate scenarios:\n${top}`);
  }

  const stepHint = `CURRENT STEP: ${state.step}. ELIGIBLE_FOR_CTA: ${eligibleForCTA(state) ? 'YES' : 'NO'}.`;

  return [
    `You are “Alex”, a friendly AI consultant for AI Agents. Keep replies concrete, visual, human.`,
    gateMsg.trim(),
    kbBits.length ? `KB NOTES:\n${kbBits.join('\n')}` : '',
    stepHint
  ].filter(Boolean).join('\n\n');
}

// ---- Handler ----
export async function POST(req: Request) {
  const { session_id, user_text, state: raw } = await req.json();

  let state = normalizeState(raw);
  state.turn = (state.turn || 0) + 1;
  state.signals = (state.signals || 0) + detectSignals(user_text);
  state.slots = updateSlotsFrom(user_text, state.slots);

  // Intro: industry match (1er passage où industry_text non mappé)
  if (state.step === 'INTRO' && state.slots.industry_text && !state.slots.industry_id) {
    const match = await kbIndustryMatch(state.slots.industry_text);
    if (match) {
      state.slots.industry_id = match.industry_id;
      state.slots.industry_name = match.industry_name || match.industry_id;
      state.slots.key_pain = match.key_pains?.split?.(';')?.[0] || match.key_pains || state.slots.key_pain;
    }
  }

  // Persona & Geo (après role + geo)
  if (state.step !== 'INTRO' && state.slots.industry_id && !state.slots.persona_id) {
    const pg = await kbPersonaGeo(state.slots.industry_id, state.slots.role_level, state.slots.geo_country, state.slots.geo_state);
    if (pg?.persona?.persona_id) state.slots.persona_id = pg.persona.persona_id;
  }

  // Scenarios (juste avant BUILDING/SELECTION)
  let scenarios: any[] = [];
  if ((state.step === 'BUILDING' || state.step === 'SELECTION') && state.slots.industry_id) {
    scenarios = await kbSearchScenarios(
      state.slots.industry_id,
      (state.slots.problems||[]).slice(0,2).join(', ') || 'intro,intake,automation'
    );
  }

  // Step progression (sans sauter)
  if (stepComplete(state)) state.step = nextStep(state);

  // CTA lock: même si le modèle tente, on lui redira “NO” via system prompt tant que pas éligible
  const sys = buildSystemPrompt(state, {
    industry: (state.slots.industry_id || state.slots.industry_text) ? {
      industry_id: state.slots.industry_id,
      industry_name: state.slots.industry_name,
      key_pains: state.slots.key_pain
    } : null,
    persona: state.slots.persona_id ? { persona_id: state.slots.persona_id } : null,
    geo: null,
    scenarios
  });

  // Compose chat messages (tu peux ajouter l'historique côté client si besoin)
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: sys },
    { role: 'user', content: user_text }
  ];

  // Modèle compact pour vitesse; tu peux passer à gpt-4o si nécessaire
  const stream = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    stream: true,
    temperature: 0.4,
    messages
  });

  // Edge streaming → Response
  const rs = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        for await (const part of stream) {
          const delta = (part.choices?.[0]?.delta?.content || '');
          if (delta) controller.enqueue(enc.encode(delta));
        }
      } catch (e) {
        controller.enqueue(new TextEncoder().encode('…network error')); // soft
      } finally {
        controller.close();
      }
    }
  });

  // ATTENTION au CTA: si une réponse côté modèle force un CTA prématuré, on ne change PAS state.step.
  // On autorisera CTA seulement quand eligibleForCTA(state) sera vrai.
  if (state.step === 'CTA' && !eligibleForCTA(state)) {
    // rétrograde virtuellement côté prompt (mais on garde step=CTA pour ne pas reculer l'état utilisateur)
    // le system prompt déjà envoyé bloque le CTA → le modèle proposera de continuer discovery/selection.
  }

  const next = JSON.stringify(state);
  return new Response(rs, { headers: { 'x-next-state': next } });
}
