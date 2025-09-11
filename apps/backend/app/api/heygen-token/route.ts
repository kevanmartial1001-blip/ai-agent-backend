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

export async function POST() {
  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Missing HEYGEN_API_KEY" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
  try {
    const r = await fetch("https://api.heygen.com/v1/streaming.create_token", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) {
      const t = await r.text();
      return new Response(JSON.stringify({ error: "heygen_token_failed", details: t }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    const j = await r.json();
    return new Response(JSON.stringify({ token: j?.data?.token || j?.token }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (e:any) {
    return new Response(JSON.stringify({ error: e?.message || "token_error" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}
