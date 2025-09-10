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

async function sttDeepgram(blob, type, lang) {
  const params = new URLSearchParams({
    model: 'nova-2-general',
    smart_format: 'true',
    punctuate: 'true',
    detect_language: lang ? 'false' : 'true'
  }).toString();
  const url = `https://api.deepgram.com/v1/listen?${params}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Token ' + process.env.DEEPGRAM_API_KEY, 'Content-Type': type || 'application/octet-stream' },
    body: blob
  });
  const t = await r.text(); let d = {}; try { d = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error(d?.error || t || `HTTP ${r.status}`);
  const alt = d?.results?.channels?.[0]?.alternatives?.[0];
  return { ok: true, text: alt?.transcript || '', language: (alt?.language || '').toLowerCase() };
}

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
  const t = await r.text(); let d = {}; try { d = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error(d?.error?.message || t || `HTTP ${r.status}`);
  return { ok: true, text: d.text || '', language: (d.language || '').toLowerCase() };
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

    const provider = (process.env.STT_PROVIDER || 'openai').toLowerCase();
    // 1) Essaye Deepgram si demandé
    if (provider === 'deepgram') {
      try {
        const r = await sttDeepgram(blob, type, lang);
        if (r && r.ok && r.text) return json(r, 200, CORS);
        // si pas de texte, on tente Whisper
      } catch (e) {
        // fallback Whisper
      }
      try {
        const r2 = await sttWhisper(blob, type, lang);
        return json(r2, 200, CORS);
      } catch (e2) {
        return json({ ok: false, error: String(e2?.message || e2) }, 502, CORS);
      }
    }

    // 2) Par défaut: Whisper
    const r = await sttWhisper(blob, type, lang);
    return json(r, 200, CORS);
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500, CORS);
  }
}
