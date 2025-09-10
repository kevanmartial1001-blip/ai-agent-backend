export const config = { runtime: 'edge' };
const HG='https://api.heygen.com/v1';
const json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json','access-control-allow-origin':'*'}});
export default async function handler(req){
  if (req.method==='OPTIONS') return json({},204);
  const { session_id, text } = await req.json();
  if (!session_id || !text) return json({ ok:false, error:'missing params' }, 400);
  const r=await fetch(`${HG}/streaming.task`,{
    method:'POST',
    headers:{'X-Api-Key':process.env.HEYGEN_API_KEY,'content-type':'application/json'},
    body:JSON.stringify({ session_id, text, task_type:'repeat', task_mode:'sync' })
  });
  if(!r.ok){ const t=await r.text(); return json({ ok:false, error:t }, r.status); }
  return json({ ok:true });
}
