export const runtime = "nodejs";

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

export async function POST(req: Request) {
  const dgKey = process.env.DEEPGRAM_API_KEY;
  if (!dgKey) {
    return new Response(JSON.stringify({ error: "Missing DEEPGRAM_API_KEY" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
  try {
    const audio = await req.arrayBuffer();
    const url = "https://api.deepgram.com/v1/listen?model=nova-2-general&smart_format=true&punctuate=true&detect_language=true";

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${dgKey}`,
        "Content-Type": "audio/webm"
      },
      body: audio
    });

    const j = await r.json();
    let text = "";
    try {
      text = j.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      if (!text && Array.isArray(j.results)) {
        const alt = j.results[0]?.channels?.[0]?.alternatives?.[0];
        text = alt?.transcript || "";
      }
      if (!text && j.transcript) text = j.transcript;
    } catch {}

    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (e:any) {
    return new Response(JSON.stringify({ error: e?.message || "stt_error" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}
