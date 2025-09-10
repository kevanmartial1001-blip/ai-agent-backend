export const config = { runtime: 'edge' };
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization'
};
const json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{...CORS,'content-type':'application/json'}});

export default async function handler(req){
  if (req.method==='OPTIONS') return new Response(null,{status:204,headers:CORS});
  try{
    const { audio_b64, mime, lang } = await req.json();
    if (!audio_b64) return json({ ok:false, error:'missing audio_b64' }, 400);

    const bytes = Uint8Array.from(atob(audio_b64), c => c.charCodeAt(0));
    const type = mime || 'audio/mp4';
    const file = new Blob([bytes], { type });
    const fd = new FormData();
    fd.append('model','whisper-1');
    if (lang) fd.append('language', lang);
    fd.append('response_format','verbose_json');
    fd.append('file', file, 'clip.'+(type.includes('webm')?'webm':type.includes('ogg')?'ogg':type.includes('mp3')?'mp3':'m4a'));

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions',{
      method:'POST', headers:{ 'authorization':'Bearer '+process.env.OPENAI_API_KEY }, body: fd
    });
    const t=await r.text(); let d={}; try{ d=JSON.parse(t);}catch{}
    if(!r.ok) return json({ ok:false, error:t }, r.status);
    return json({ ok:true, text: d.text || '', language: (d.language||'').toLowerCase() });
  }catch(e){
    return json({ ok:false, error:String(e?.message||e) }, 500);
  }
}
