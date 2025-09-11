"use client";

/**
 * Bare video page for the AI call.
 * - Loads HeyGen SDK via your proxy /api/heygen-sdk
 * - Starts avatar on postMessage { cmd: "start" }
 * - Stops avatar on postMessage { cmd: "stop" }
 * - Auto-Listen: mic + VAD -> /api/stt -> parent postMessage { type:"transcript", text }
 * - Speak: listens to { cmd:"speak", text } to voice partial sentences in real-time
 * - Posts { type:"ready" } when loaded and { type:"status", value } changes
 */

import { useEffect, useRef, useState } from "react";

export default function CallBare() {
  const AVATAR_ID = "5c3a094338ac46649c630d3929a78196";
  const TOKEN_URL = "/api/heygen-token";
  const STT_URL   = "/api/stt";
  const SDK_URL   = "/api/heygen-sdk"; // proxy local

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const avatarRef = useRef<any>(null);
  const TaskTypeRef = useRef<any>(null);

  const [status, setStatus] = useState<"offline"|"live">("offline");
  const listeningRef = useRef(false);

  // --- utils
  function post(msg: any) {
    try { window.parent?.postMessage(msg, "*"); } catch {}
  }

  async function loadSDK() {
    const mod = await import(SDK_URL);
    return mod;
  }

  async function getToken() {
    const r = await fetch(TOKEN_URL, { method: "POST" });
    if (!r.ok) throw new Error("token_failed");
    const j = await r.json();
    return j.token as string;
  }

  async function startAvatar() {
    try {
      const { StreamingAvatar, StreamingEvents, AvatarQuality, TaskType } = await loadSDK();
      const token = await getToken();

      const avatar = new StreamingAvatar({ token });
      avatar.on(StreamingEvents.STREAM_READY, (ev: any) => {
        const stream = ev.detail;
        if (videoRef.current && stream) {
          videoRef.current.srcObject = stream;
          videoRef.current.muted = false;
          videoRef.current.play().catch(()=>{});
        }
        setStatus("live");
        post({ type: "status", value: "live" });
      });

      await avatar.createStartAvatar({
        quality: AvatarQuality.High,
        avatarName: AVATAR_ID,
        language: "en",
        activityIdleTimeout: 600
      });

      avatarRef.current = avatar;
      TaskTypeRef.current = TaskType;

      // greet is handled by parent via "speak", we just start listening
      autoListen();
    } catch (e:any) {
      post({ type: "error", value: e?.message || "engine_error" });
    }
  }

  async function stopAvatar() {
    try { await avatarRef.current?.stopAvatar(); } catch {}
    listeningRef.current = false;
    setStatus("offline");
    post({ type: "status", value: "offline" });
  }

  // --- Auto Listen (VAD + Deepgram)
  async function autoListen() {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
      });
      listeningRef.current = true;

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
            if (text) post({ type: "transcript", text });
          } catch {
            post({ type: "error", value: "stt_failed" });
          }
        };
        rec.start(300);
      }
      function stopChunk() { if (rec && rec.state !== "inactive") rec.stop(); rec = null; }

      function loop() {
        if (!listeningRef.current) return;
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
      post({ type: "error", value: "mic_denied" });
    }
  }

  // --- Speak segments coming from parent (per-sentence for low latency)
  async function speak(text: string) {
    if (!text?.trim()) return;
    try {
      await avatarRef.current?.speak({ text, task_type: TaskTypeRef.current?.REPEAT });
    } catch {}
  }

  // --- PostMessage control plane
  useEffect(() => {
    post({ type: "ready" });
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data || {};
      if (!d || typeof d !== "object") return;
      if (d.cmd === "start") startAvatar();
      else if (d.cmd === "stop") stopAvatar();
      else if (d.cmd === "speak") speak(String(d.text || ""));
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ background:"#000", width:"100%", height:"100vh" }}>
      <video ref={videoRef} autoPlay playsInline style={{ width:"100%", height:"100%", objectFit:"cover", background:"#000" }} />
      {/* No UI — controlled by parent via postMessage */}
    </div>
  );
}
