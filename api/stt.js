// api/stt.js
export const config = { runtime: 'edge' };

const json = (d, s = 200, h = {}) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...h, 'content-type': 'application/json' } });

function corsHeaders(req) {
  const allow = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.get('origin') || '';
  const ok = allow.includes('*') || allow.includes(origin);
  return {
    'access-control-allow-origin': ok ? (allow.includes('*') ? '*' : origin) : 'null',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization'
  };
}

// ---- Deepgram (realtime HTTP) ----
async function sttDeepgram(blob, type, lang) {
  // modèle robuste et reconnu: "nova-2"
  const qs = new URLSearchParams({
    model: 'nova-2',
    smart_format: 'true',
    punctuate: 'true',
    ...(lang ? { language: lang, detect_language: 'false' } : { detect_language: 'true' })
  }).toString();
  const url = `https://api.deepgram.com/v1/listen?${qs}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Token ' + process.env.DEEPGRAM_API_KEY,
      'Content-Type': type || 'application/octet-stream'
    },
    body: blob
  });
  const t = await r.text();
  let d = {};
  try { d = JSON.parse(t); } catch {}
  if (!r.ok) {
    const msg = d?.error || d?.message || t || `HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  const alt = d?.results?.channels?.[0]?.alternatives?.[0];
  return {
    ok: true,
    provider: 'deepgram',
    text: alt?.transcript || '',
    language: (alt?.language || '').toLowerCase()
  };
}

// ---- OpenAI Whisper (secours) ----
async function sttWhisper(blob, type, lang) {
  const fd = new FormData();
  fd.append('model', 'whisper-1');
  if (lang) fd.append('language', lang);
  fd.append('response_format', 'verbose_json');
  fd.append('file', blob, 'clip.' + (type?.includes('webm') ? 'webm' : type?.includes('ogg') ? 'ogg' : type?.includes('mp3') ? 'mp3' : 'm4a'));
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
    body: fd
  });
  const t = await r.text();
  let d = {};
  try { d = JSON.parse(t); } catch {}
  if (!r.ok) {
    const msg = d?.error?.message || t || `HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return { ok: true, provider: 'whisper', text: d.text || '', language: (d.language || '').toLowerCase() };
}

export default async function handler(req) {
  const CORS = corsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    const { audio_b64, mime, lang } = await req.json();
    if (!audio_b64) return json({ ok: false, error: 'missing audio_b64' }, 400, CORS);

    const bytes = Uint8Array.from(atob(audio_b64), c => c.charCodeAt(0));
    const type = mime || 'audio/mp4';
    const blob = new Blob([bytes], { type });

    const want = (process.env.STT_PROVIDER || 'openai').toLowerCase();

    // 1) Deepgram prioritaire
    if (want === 'deepgram') {
      if (!process.env.DEEPGRAM_API_KEY) {
        // clé absente -> on n’essaie même pas Deepgram
        try {
          const r2 = await sttWhisper(blob, type, lang);
          return json({ ...r2, fallback: 'missing_deepgram_key' }, 200, CORS);
        } catch (e2) {
          return json({ ok: false, error: String(e2?.message || e2), provider: 'whisper' }, e2?.status || 502, CORS);
        }
      }
      try {
        const r = await sttDeepgram(blob, type, lang);
        return json(r, 200, CORS);
      } catch (e) {
        // Deepgram a échoué -> tente Whisper
        try {
          const r2 = await sttWhisper(blob, type, lang);
          return json({ ...r2, fallback: 'deepgram_error', deepgram_error: String(e?.message || e) }, 200, CORS);
        } catch (e2) {
          return json({
            ok: false,
            error: String(e2?.message || e2),
            provider: 'whisper',
            deepgram_error: String(e?.message || e)
          }, e2?.status || 502, CORS);
        }
      }
    }

    // 2) Par défaut: Whisper seul
    const r = await sttWhisper(blob, type, lang);
    return json(r, 200, CORS);
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500, CORS);
  }
}
