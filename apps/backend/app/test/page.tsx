export default function TestPage() {
  async function call() {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ session_id:'dev', user_text:'Bonjour, je gère un 3PL à Dubaï', state:{} })
    });
    const reader = r.body?.getReader(); const dec = new TextDecoder(); let buf='';
    while (reader) { const {done,value}=await reader.read(); if (done) break; buf += dec.decode(value,{stream:true}); }
    alert('Réponse stream OK. Vérifie l’onglet Network pour le détail.');
  }
  return <div style={{padding:20}}><button onClick={call}>Tester /api/chat</button></div>;
}
