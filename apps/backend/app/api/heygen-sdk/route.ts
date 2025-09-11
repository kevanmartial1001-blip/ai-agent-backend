// app/api/heygen-sdk/route.ts
// Proxy du SDK ESM HeyGen via TON domaine (évite le blocage CSP sur Shopify)
export const runtime = "nodejs";
export const dynamic = "force-static";

export async function GET() {
  const upstream = "https://cdn.jsdelivr.net/npm/@heygen/streaming-avatar/+esm";
  try {
    const r = await fetch(upstream, { cache: "no-store" });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return new Response(`/* fetch failed ${r.status} */\n` + txt, {
        status: 500,
        headers: {
          "Content-Type": "text/javascript; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, s-maxage=3600, max-age=0",
        },
      });
    }
    const code = await r.text();
    return new Response(code, {
      status: 200,
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, s-maxage=86400, max-age=0",
      },
    });
  } catch (e: any) {
    return new Response(`/* proxy error */\nconsole.error(${JSON.stringify(e?.message || "proxy_error")});`, {
      status: 500,
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}
