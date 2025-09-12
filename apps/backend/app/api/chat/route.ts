/* app/api/chat/route.ts
   Conversational Flow Guard + KB-lite enrichment + streaming
   Env: OPENAI_API_KEY, KB_BASE_URL (Apps Script/Web API)
*/
export const runtime = 'edge';

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

type Step =
  | 'INTRO'              // Turn 1: name+what you do; Turn 2: ack + ask location
  | 'AI_PRIMER'
  | 'AGENTS_PRIMER'
  | 'INDUSTRY_PROBLEMS'
  | 'DISCOVERY'          // must capture typical_day
  | 'SELECTION'
  | 'CTA';

type RoleLevel = 'CEO'|'C_SUITE'|'MANAGEMENT'|'EMPLOYEES'|'UNKNOWN';

interface Slots {
  user_name?: string;
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
  typical_day?: string;          // <— obligatoire pour sortir de DISCOVERY
  persona_id?: string;
}

interface AgentState {
  step: Step;
  started_at?: number;       // epoch seconds (session)
  step_started_at?: number;  // epoch seconds (current step)
  turn?: number;             // total exchanges
  step_turns?: number;       // exchanges within the current step
  signals?: number;          // buying signals
  slots: Slots;
}

// -------- CONFIG --------
const MIN_TURNS_BEFORE_CTA = 10;     // ~10 tours → ~7 min live
const MIN_SECONDS_BEFORE_CTA = 420;  // 7 minutes
const MIN_SIGNALS = 3;

// pacing minimal par step
const MIN_TURNS_PER_STEP: Partial<Record<Step, number>> = {
  AI_PRIMER: 2,
  AGENTS_PRIMER: 2,
  INDUSTRY_PROBLEMS: 2,
  DISCOVERY: 2,
  SELECTION: 2
};

// -------- KB helpers --------
const KB_BASE = process.env.KB_BASE_URL; // ex: https://script.google.com/macros/s/XXX/exec

async function kbIndustryMatch(q: string) {
  if (!KB_BASE || !q) return null;
  const url = `${KB_BASE}?fn=industry_match&q=${encodeURIComponent(q)}`;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function kbSearchScenarios(industry_id?: string, q?: string) {
  if (!KB_BASE || !industry_id) return [];
  const url = `${KB_BASE}?fn=scenarios&industry_id=${encodeURIComponent(industry_id)}&q=${encodeURIComponent(q||'')}&limit=6`;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

// -------- State helpers --------
const nowSec = () => Math.floor(Date.now() / 1000);

function normalizeState(input: any): AgentState {
  const now = nowSec();
  const s: AgentState = {
    step: (input?.step as Step) || 'INTRO',
    started_at: typeof input?.started_at === 'number' ? input.started_at : now,
    step_started_at: typeof input?.step_started_at === 'number' ? input.step_started_at : now,
    turn: typeof input?.turn === 'number' ? input.turn : 0,
    step_turns: typeof input?.step_turns === 'number' ? input.step_turns : 0,
    signals: typeof input?.signals === 'number' ? input.signals : 0,
    slots: input?.slots || {}
  };
  return s;
}

function detectSignals(text: string): number {
  const sigs = [
    /this is great|love this|awesome|perfect|we need this|let's do it|sounds good/i,
    /send (me )?a demo|free trial|try it/i,
    /book (a )?call|schedule|set up/i,
    /pricing|cost|how much/i
  ];
  return sigs.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
}

function updateSlotsFrom(text: string, slots: Slots, currentStep: Step): Slots {
  // name (best-effort)
  if (!slots.user_name) {
    const m = text.match(/\b(?:I am|I'm|I’m|My name is|Je m'appelle|Je m’appelle)\s+([A-Z][\p{L}’'-]+(?:\s+[A-Z][\p{L}’'-]+)*)/iu);
    if (m) slots.user_name = m[1];
  }

  // country
  if (!slots.geo_country) {
    const m = text.match(/\b(USA|United States|Canada|United Kingdom|UK|France|Germany|Spain|Australia|Singapore|UAE)\b/i);
    if (m) slots.geo_country = m[0].toUpperCase() === 'UK' ? 'United Kingdom' : m[0];
  }
  // US state
  if (slots.geo_country && /USA|United States/i.test(slots.geo_country) && !slots.geo_state) {
    const st = text.match(/\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV)\b/);
    if (st) slots.geo_state = st[0];
  }
  // role
  if (!slots.role_level) {
    if (/CEO|founder|owner/i.test(text)) slots.role_level = 'CEO';
    else if (/C[-\s]?suite|CFO|COO|CTO|CMO/i.test(text)) slots.role_level = 'C_SUITE';
    else if (/manager|head of|director/i.test(text)) slots.role_level = 'MANAGEMENT';
    else if (/agent|rep|staff|employee/i.test(text)) slots.role_level = 'EMPLOYEES';
    else slots.role_level = 'UNKNOWN';
  }
  // quick pain capture
  if (/pain|problem|issue|bottleneck|slow|manual|error|churn|stockout|delay|retard|erreur/i.test(text)) {
    const p = (slots.problems || []);
    if (p.length < 6) p.push(text.slice(0, 180));
    slots.problems = p;
  }
  // typical day (when in DISCOVERY we treat the user message as the day description if long enough)
  if (currentStep === 'DISCOVERY' && !slots.typical_day) {
    const wordCount = (text.trim().match(/\S+/g) || []).length;
    if (wordCount >= 15) slots.typical_day = text.slice(0, 1200);
  }
  return slots;
}

function stepMinTurns(step: Step): number {
  return MIN_TURNS_PER_STEP[step] ?? 1;
}

function stepComplete(state: AgentState): boolean {
  const s = state.slots;
  const t = state.step_turns ?? 0;
  switch (state.step) {
    case 'INTRO':
      // enforce 2 turns in INTRO: (1) name+what you do, (2) ack + ask location
      return t >= 2 && !!(s.industry_id || s.industry_text) && !!s.role_level && !!s.geo_country;
    case 'AI_PRIMER':
    case 'AGENTS_PRIMER':
    case 'INDUSTRY_PROBLEMS':
      return t >= stepMinTurns(state.step);
    case 'DISCOVERY':
      // MUST have typical_day + at least 1 problem captured
      return !!s.typical_day && (s.problems?.length || 0) >= 1 && t >= stepMinTurns(state.step);
    case 'SELECTION':
      return t >= stepMinTurns(state.step);
    case 'CTA':
      return true;
  }
}

function nextStep(state: AgentState): Step {
  const order: Step[] = ['INTRO','AI_PRIMER','AGENTS_PRIMER','INDUSTRY_PROBLEMS','DISCOVERY','SELECTION','CTA'];
  const idx = order.indexOf(state.step);
  return order[Math.min(idx + 1, order.length - 1)];
}

function eligibleForCTA(state: AgentState): boolean {
  const elapsed = nowSec() - (state.started_at || nowSec());
  const okTurns = (state.turn || 0) >= MIN_TURNS_BEFORE_CTA;
  const okTime  = elapsed >= MIN_SECONDS_BEFORE_CTA;
  const okSig   = (state.signals || 0) >= MIN_SIGNALS;
  const s = state.slots;
  const haveBasics =
    !!(s.industry_id || s.industry_text) &&
    !!s.role_level &&
    !!s.geo_country &&
    !!s.typical_day &&
    (s.problems?.length || 0) >= 1;
  return okTurns && okTime && okSig && haveBasics;
}

// -------- System prompt --------
function buildSystemPrompt(state: AgentState, kb: {industry?: any, scenarios?: any[]}) {
  const pacing = `
PACING & QUESTIONS:
- One question per turn, always at the end.
- Avoid interrogation. In AI_PRIMER / AGENTS_PRIMER / INDUSTRY_PROBLEMS, prioritize informative guidance (2–4 sentences), then one short question.
- Keep 3–6 sentences per turn. Visual, concrete, human.

STRICT MICRO-FLOW FOR INTRO:
- Turn 1: Ask ONLY “Could you introduce yourself—your name and what you do?”
- Turn 2: Acknowledge their industry with ONE relatable pain and a friendly common-ground line. Then ask ONLY “Where are you based? (Country; if USA, which state?)”.

FLOW (strict):
1) INTRO → micro-flow above (2 turns min) and capture industry + role + location.
2) AI_PRIMER → ask familiarity; explain what AI is changing now and why.
3) AGENTS_PRIMER → ask if they know AI Agents / digital employees; explain with 1–2 general examples.
4) INDUSTRY_PROBLEMS → state common pains & consequences for their industry; ask permission to show tailored examples.
5) DISCOVERY → MANDATORY “typical day” question; then ask about handoffs, repetitive tasks, manual vs automated (one per turn).
6) SELECTION → suggest 2–3 agents (each: actual → problem → how it works → life-after).
7) CTA → ONLY when the server says eligible. If asked early: acknowledge and continue until eligible.

GUARDRAILS:
- NEVER offer a demo before STEP 7 and server eligibility.
- Use “typically”, “likely”, “teams like yours see…”. No hard promises.
- For detailed/regulated info: brief answer + say you’ll also share details in the chat panel.
`;

  const stepHint = `CURRENT STEP: ${state.step}. ELIGIBLE_FOR_CTA: ${eligibleForCTA(state) ? 'YES' : 'NO'}.`;
  const kbBits: string[] = [];

  if (kb.industry) {
    const name = kb.industry.industry_name || kb.industry.industry_id || 'this industry';
    kbBits.push(`INDUSTRY: ${name}`);
    if (kb.industry.key_pains) kbBits.push(`Common pains: ${kb.industry.key_pains}`);
  }
  if (kb.scenarios?.length) {
    const top = kb.scenarios.slice(0,3).map((s:any)=>`• ${s.agent_name}: ${s.actual_situation} → ${s.problem} → how: ${s.how_it_works} → life-after: ${s.narrative}`).join('\n');
    kbBits.push(`Candidate scenarios:\n${top}`);
  }

  return [
    `You are “Alex”, a friendly AI consultant for AI Agents. Mirror the user’s language. Keep it concrete and visual.`,
    pacing.trim(),
    kbBits.length ? `KB NOTES:\n${kbBits.join('\n')}` : '',
    stepHint
  ].filter(Boolean).join('\n\n');
}

// -------- Handler --------
export async function POST(req: Request) {
  const { user_text, state: raw } = await req.json();

  let state = normalizeState(raw);
  const prevStep = state.step;
  state.turn = (state.turn || 0) + 1;
  state.step_turns = (state.step_turns || 0) + 1;
  state.signals = (state.signals || 0) + detectSignals(user_text);
  state.slots = updateSlotsFrom(user_text, state.slots, state.step);

  // INTRO: industry mapping when industry_text present
  if (state.step === 'INTRO' && state.slots.industry_text && !state.slots.industry_id) {
    const match = await kbIndustryMatch(state.slots.industry_text);
    if (match) {
      state.slots.industry_id = match.industry_id;
      state.slots.industry_name = match.industry_name || match.industry_id;
      state.slots.key_pain = match.key_pains?.split?.(';')?.[0] || match.key_pains || state.slots.key_pain;
    }
  }

  // Scenarios lookup when needed
  let scenarios: any[] = [];
  if ((state.step === 'INDUSTRY_PROBLEMS' || state.step === 'SELECTION') && state.slots.industry_id) {
    const q = (state.slots.problems||[]).slice(0,2).join(', ') || 'intro,intake,automation';
    scenarios = await kbSearchScenarios(state.slots.industry_id, q);
  }

  // Progression (no skipping)
  if (stepComplete(state)) {
    state.step = nextStep(state);
    state.step_turns = 0;
    state.step_started_at = nowSec();
  }

  const sys = buildSystemPrompt(state, {
    industry: (state.slots.industry_id || state.slots.industry_text) ? {
      industry_id: state.slots.industry_id,
      industry_name: state.slots.industry_name,
      key_pains: state.slots.key_pain
    } : null,
    scenarios
  });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: sys },
    { role: 'user', content: user_text }
  ];

  const stream = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    stream: true,
    temperature: 0.4,
    messages
  });

  const rs = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        for await (const part of stream) {
          const delta = (part.choices?.[0]?.delta?.content || '');
          if (delta) controller.enqueue(enc.encode(delta));
        }
      } catch {
        controller.enqueue(new TextEncoder().encode('…network error'));
      } finally {
        controller.close();
      }
    }
  });

  // CTA hard lock – le modèle ne peut pas forcer le CTA avant l’éligibilité
  if (state.step === 'CTA' && !eligibleForCTA(state)) {
    // on ne recule pas l'étape, mais le system prompt garde ELIGIBLE_FOR_CTA: NO
  }

  return new Response(rs, {
    headers: { 'x-next-state': JSON.stringify(state) }
  });
}
