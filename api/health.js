export const config = { runtime: 'edge' };
export default async function handler(req){
  return new Response(JSON.stringify({ ok:true, msg:'backend up' }), {
    status: 200,
    headers: { 'content-type':'application/json','access-control-allow-origin':'*' }
  });
}
