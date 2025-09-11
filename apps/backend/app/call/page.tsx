"use client";

import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    __heygen?: any;
  }
}

export default function Call() {
  // Config
  const AVATAR_ID = "5c3a094338ac46649c630d3929a78196";
  const API_BASE  = ""; // même domaine
  const TOKEN_URL = "/api/heygen-token";
  const CHAT_URL  = "/api/chat";
  const STT_URL   = "/api/stt";
  const SDK_URL   = "/api/heygen-sdk"; // proxy local

  // State/UI
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState("Offline • Alex");
  const [log, setLog] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);

  // HeyGen SDK
  const avatarRef = useRef<any>(null);
  const speakingRef = useRef(false);
  const speakQueue = useRef<string[]>([]);
  function pushLog(role: "bot" | "user", text: string) {
    setLog((l) => [...l, (role === "user" ? "You: " : "Alex: ") + text]);
  }

  async function loadSDK() {
    if ((window as any).__heygen) return (window as any).__heygen;
    const mod = await import(SDK_URL);
    (window as any).__heygen = mod;
    return mod;
  }

  async function getToken() {
    const r = await fetch(TOKEN_URL, { method: "POST" });
    const j = await r.json();
    return j.token as string;
  }

  async function start() {
    try {
      const { StreamingAvatar, StreamingEvents, AvatarQuality, TaskType } = await loadSDK();
      const token = await getToken();
      const avatar = new StreamingAvatar({ token });

      avatar.on(StreamingEvents.STREAM_READY, (ev: any) => {
        const stream = ev.detail;
        if (videoRef.current && stream) {
          videoRef.current.srcObject = stream;
          videoRef.current.muted = false;
          videoRef.current.play().catch(() => {});
        }
        setStatus("Live • Alex");
      });

      await avatar.createStartAvatar({
        quality: (AvatarQuality as any).High,
        avatarName: AVATAR_ID,
        language: "en",
        activityIdleTimeout: 600
      });

      avatarRef.current = { avatar, TaskType };

      const greet = "Hi! I’m Alex. I’m listening. Tell me your industry, role and where you’re based.";
      pushLog("bot", greet);
      await avatar.speak({ text: greet, task_type: (TaskType as any).REPEAT });

      autoListen(); // micro + VAD
    } catch (e: any) {
      pushLog("bot", "Voice engine failed to load here. Please check browser permissions.");
    }
  }

  async function stop() {
    try { await avatarRef.current?.avatar?.stopAvatar(); } catch {}
    setStatus("Offline • Alex");
    setListening(false);
  }

  async function sendToKBStream(userText: string) {
    if (!userText || sending) return;
    setSending(true);
    pushLog("user", userText);

    try {
      const res = await fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_text: userText })
      });

      const nextHeader = res.headers.get("x-next-state"); // tu peux l’utiliser si besoin
      // Streaming read
      const reader = res.body?.getReader();
      const dec = new TextDecoder();
      let full = "";
      let sentenceBuf = "";

      async function enqueueSpeak(text: string) {
        if (!text.trim()) return;
        speakQueue.current.push(text.trim());
        if (speakingRef.current) return;
        speakingRef.current = true;
        while (speakQueue.current.length) {
          const t = speakQueue.current.shift()!;
          await avatarRef.current?.avatar?.speak({ text: t, task_type: avatarRef.current?.TaskType?.REPEAT });
        }
        speakingRef.current = false;
      }

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        full += chunk;
        sentenceBuf += chunk;

        // Affiche en direct
        setLog((l) => {
          const copy = [...l];
          const last = copy[copy.length - 1];
          if (last && last.startsWith("Alex: ")) {
            copy[copy.length - 1] = "Alex: " + (full || "");
          } else {
            copy.push("Alex: " + (full || ""));
          }
          return copy;
        });

        // Déclenche parole par phrases
        const boundary = sentenceBuf.search(/[\.!?]\s/);
        if (boundary > 40) {
          const sent = sentenceBuf.slice(0, boundary + 1);
          sentenceBuf = sentenceBuf.slice(boundary + 1);
          await enqueueSpeak(sent);
        }
      }

      if (sentenceBuf.trim()) {
        await enqueueSpeak(sentenceBuf.trim());
      }
    } catch {
      pushLog("bot", "…network error, please try again.");
    } finally {
      setSending(false);
    }
  }

  // ---- Auto listen (VAD simple) ----
  async function autoListen() {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      setListening(true);

      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = ctx.createMediaStreamSource(mic);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);

      const data = new Float32Array(analyser.fftSize);
      let isSpeaking = false, rec: MediaRecorder | null = null, chunks: Blob[] = [];
      let silenceMs = 0, lastTime = performance.now();
      let baseline = 0, frames = 0, calibrated = false;
      const CAL_MS = 500, SILENCE_HOLD = 600;

      function rms(arr: Float32Array){ let s=0; for(let i=0;i<arr.length;i++){ s+=arr[i]*arr[i]; } return Math.sqrt(s/arr.length); }

      function startChunk() {
        chunks = [];
        rec = new MediaRecorder(mic, { mimeType: "audio/webm" });
        rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        rec.onstop = async () => {
          const blob = new Blob(chunks, { type: "audio/webm" });
          if (blob.size < 2000) return;
          try {
            const stt = await fetch(STT_URL, { method: "POST", headers: { "Content-Type": "audio/webm" }, body: blob });
            const j = await stt.json();
            const text = (j.text || "").trim();
            if (text) await sendToKBStream(text);
          } catch {
            pushLog("bot", "(STT error)");
          }
        };
        rec.start(300);
      }
      function stopChunk() { if (rec && rec.state !== "inactive") rec.stop(); rec = null; }

      function loop() {
        if (!listening) return;
        requestAnimationFrame(loop);
        analyser.getFloatTimeDomainData(data);
        const now = performance.now(), dt = now - lastTime; lastTime = now;
        const level = rms(data);

        if (!calibrated) {
          baseline += level; frames++;
          const elapsedMs = frames * (analyser.fftSize / 44100) * 1000;
          if (elapsedMs >= CAL_MS) { baseline = baseline / frames; calibrated = true; }
          return;
        }

        const THRESH = Math.max(0.01, baseline * 3);

        if (level > THRESH) {
          silenceMs = 0;
          if (!isSpeaking) { isSpeaking = true; startChunk(); }
        } else {
          if (isSpeaking) {
            silenceMs += dt;
            if (silenceMs > SILENCE_HOLD) { isSpeaking = false; stopChunk(); }
          }
        }
      }
      loop();
    } catch {
      pushLog("bot", "Microphone permission denied.");
    }
  }

  return (
    <div style={{ background:"#0f1115", color:"#e8eaf0", minHeight:"100vh", display:"grid", gridTemplateColumns:"minmax(0,2fr) minmax(280px,1fr)", gap:14, padding:16 }}>
      {/* Stage */}
      <div style={{ position:"relative", background:"#161a22", border:"1px solid #23293a", borderRadius:16, overflow:"hidden", minHeight:"76vh" }}>
        <video ref={videoRef} autoPlay playsInline style={{ width:"100%", height:"100%", objectFit:"cover", background:"#000" }} />
        <div style={{ position:"absolute", left:12, top:12, display:"flex", gap:8 }}>
          <span style={{ background:"#10213a", border:"1px solid #1a3a7a", color:"#cfe1ff", padding:"4px 10px", borderRadius:999, fontSize:12, fontWeight:700 }}>{status}</span>
          {listening && <span style={{ display:"inline-flex", alignItems:"center", gap:8, background:"#0b1b10", border:"1px solid #123b22", color:"#b9f6ca", padding:"4px 10px", borderRadius:999, fontSize:12 }}><span style={{ width:9, height:9, borderRadius:"50%", background:"#22c55e", boxShadow:"0 0 0 6px rgba(34,197,94,.12)" }} />Listening…</span>}
        </div>
        <div style={{ position:"absolute", left:0, right:0, bottom:0, background:"linear-gradient(180deg,transparent,rgba(15,17,21,.88))", padding:"10px 12px" }}>
          <div style={{ display:"flex", gap:8, justifyContent:"space-between", alignItems:"center" }}>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={start} style={{ padding:"10px 14px", borderRadius:10, border:"none", background:"#4f8cff", color:"#fff", fontWeight:700 }}>Start</button>
              <button onClick={stop} style={{ padding:"10px 14px", borderRadius:10, border:"none", background:"#ef4444", color:"#fff", fontWeight:700 }}>End</button>
            </div>
            <div style={{ display:"flex", gap:8, flex:1 }}>
              <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter"){ const t=input.trim(); if(t){ setInput(""); pushLog("user", t); sendToKBStream(t);} } }} placeholder="Type a message…" style={{ flex:1, background:"#202534", border:"1px solid #23293a", borderRadius:10, color:"#e8eaf0", padding:"12px" }} />
              <button disabled={sending} onClick={()=>{ const t=input.trim(); if(!t) return; setInput(""); pushLog("user", t); sendToKBStream(t); }} style={{ padding:"10px 14px", borderRadius:10, border:"none", background:"#4f8cff", color:"#fff", fontWeight:700 }}>{sending ? "Sending…" : "Send"}</button>
            </div>
          </div>
        </div>
      </div>

      {/* Chat */}
      <div style={{ background:"#161a22", border:"1px solid #23293a", borderRadius:16, minHeight:"76vh", display:"flex", flexDirection:"column", overflow:"hidden" }}>
        <div style={{ padding:"10px 12px", borderBottom:"1px solid #23293a", display:"flex", justifyContent:"space-between" }}>
          <div style={{ fontWeight:700 }}>Chat</div>
          <button onClick={()=>setLog([])} style={{ padding:"6px 10px", borderRadius:8, border:"1px solid #23293a", background:"transparent", color:"#e8eaf0" }}>Clear</button>
        </div>
        <div style={{ flex:1, overflow:"auto", padding:12, whiteSpace:"pre-wrap" }}>
          {log.map((line, i)=>(
            <div key={i} style={{ margin:"8px 6px" }}>{line}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
