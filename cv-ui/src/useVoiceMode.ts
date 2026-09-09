import { useState, useRef, useCallback, useEffect } from 'react';
import { useAudioAnalyser } from './useAudioAnalyser';
import type { RagSource } from './types';

export type { RagSource };

export type VoiceStatus = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}

export interface VoiceState {
  status: VoiceStatus;
  transcript: TranscriptEntry[];
  error: string | null;
  remainingSeconds: number;
  inputLevel: number;
  outputLevel: number;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}



export const SESSION_TIMEOUT_S = 120;

// Gemini Live API audio is ASYMMETRIC: it accepts 16 kHz PCM and emits 24 kHz.
// Kept as two named constants so they can never collapse back into one literal
// — if they do, playback comes out at the wrong pitch. See plan §3.3 / §5.4.
const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;

const LIVE_WS_URL = (token: string) =>
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained' +
  `?access_token=${encodeURIComponent(token)}`;

export function useVoiceMode() {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [transcript, _setTranscript] = useState<TranscriptEntry[]>([]);
  const setTranscript: typeof _setTranscript = (update) => {
    _setTranscript(prev => {
      const next = typeof update === 'function' ? update(prev) : update;
      transcriptRef.current = next;
      return next;
    });
  };
  const [error, setError] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(SESSION_TIMEOUT_S);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [voiceSources, setVoiceSources] = useState<RagSource[]>([]);
  const currentPageRef = useRef('');
  const addDebug = (msg: string) => { console.log('[Voice]', msg); setDebugLog(prev => [...prev.slice(-9), msg]); };

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | ScriptProcessorNode | null>(null);
  const traceIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingListenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkingSoundStopRef = useRef<(() => void) | null>(null);
  const sessionStartRef = useRef(0);
  const sessionIdRef = useRef('');
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  // usageMetadata carries exact per-modality token counts, but is NOT guaranteed
  // to arrive before a session ends (Test §5, unplanned findings) — accumulate
  // whatever shows up and let voice-trace.js fall back when nothing did.
  const usageRef = useRef<{ inputTokens: number; outputTokens: number; audioInputTokens: number; audioOutputTokens: number } | null>(null);

  // Audio analysis
  const inputAnalyser = useAudioAnalyser();
  const outputAnalyser = useAudioAnalyser();

  // Audio playback
  const playbackContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);

  // Track partial transcripts for live display
  const currentTranscriptRef = useRef('');

  // Audio-synced subtitles: track audio duration to pace text display
  const totalAudioDurationRef = useRef(0);
  const audioStartTimeRef = useRef(0);
  const subtitleRafRef = useRef(0);

  const isSupported = typeof window !== 'undefined'
    && typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof WebSocket !== 'undefined';

  // --- Audio-synced subtitles ---
  // Uses audioContext.currentTime vs scheduled audio duration to pace text display
  function startSubtitleLoop() {
    if (subtitleRafRef.current) return; // already running

    function tick() {
      const ctx = playbackContextRef.current;
      const totalDuration = totalAudioDurationRef.current;
      const fullText = currentTranscriptRef.current;

      if (!ctx || totalDuration === 0 || !fullText) {
        subtitleRafRef.current = requestAnimationFrame(tick);
        return;
      }

      const elapsed = ctx.currentTime - audioStartTimeRef.current;
      const progress = Math.min(elapsed / totalDuration, 1);
      const charIndex = Math.floor(progress * fullText.length);

      // Show last ~120 chars of the revealed text (subtitle window)
      const revealed = fullText.slice(0, charIndex);
      if (revealed.length > 120) {
        setLiveTranscript('…' + revealed.slice(-120).trimStart());
      } else {
        setLiveTranscript(revealed);
      }

      subtitleRafRef.current = requestAnimationFrame(tick);
    }

    subtitleRafRef.current = requestAnimationFrame(tick);
  }

  function stopSubtitleLoop() {
    if (subtitleRafRef.current) {
      cancelAnimationFrame(subtitleRafRef.current);
      subtitleRafRef.current = 0;
    }
    totalAudioDurationRef.current = 0;
    audioStartTimeRef.current = 0;
    setLiveTranscript('');
  }

  // --- Thinking/searching sound effects (subtle pips like ChatGPT) ---
  function stopThinkingSound() {
    if (thinkingSoundStopRef.current) {
      thinkingSoundStopRef.current();
      thinkingSoundStopRef.current = null;
    }
  }

  function startThinkingSound() {
    stopThinkingSound();
    const ctx = playbackContextRef.current;
    if (!ctx || ctx.state === 'closed') return;

    let running = true;
    const notes = [523, 587, 659, 698]; // C5, D5, E5, F5
    let noteIdx = 0;

    function playPip() {
      if (!running || !ctx || ctx.state === 'closed') return;

      try {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = notes[noteIdx % notes.length];
        noteIdx++;

        const gain = ctx.createGain();
        const now = ctx.currentTime;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.035, now + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.2);
      } catch { /* context may be closed */ }

      setTimeout(playPip, 550 + Math.random() * 200);
    }

    // Small initial delay before first pip
    setTimeout(playPip, 300);

    thinkingSoundStopRef.current = () => { running = false; };
  }

  const cleanup = useCallback(() => {
    // Stop thinking sound and subtitles
    stopThinkingSound();
    stopSubtitleLoop();

    // Cancel pending listen transition
    if (pendingListenTimerRef.current) {
      clearTimeout(pendingListenTimerRef.current);
      pendingListenTimerRef.current = null;
    }

    // Stop timer
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    // Close WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    // Stop media tracks
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }

    // Disconnect audio processing
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }

    // Close audio contexts
    if (audioContextRef.current?.state !== 'closed') {
      audioContextRef.current?.close().catch(() => {});
    }
    audioContextRef.current = null;

    if (playbackContextRef.current?.state !== 'closed') {
      playbackContextRef.current?.close().catch(() => {});
    }
    playbackContextRef.current = null;

    inputAnalyser.disconnect();
    outputAnalyser.disconnect();
    analyserNodeRef.current = null;
  }, [inputAnalyser, outputAnalyser]);

  // Send voice trace to backend
  const sendTrace = useCallback(async (transcriptData: TranscriptEntry[], sessionId: string) => {
    if (!traceIdRef.current) return;
    try {
      await fetch('/api/voice-trace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          traceId: traceIdRef.current,
          sessionId,
          transcript: transcriptData,
          durationMs: Date.now() - sessionStartRef.current,
          usage: usageRef.current,
        }),
      });
    } catch {
      // Non-critical
    }
  }, []);

  // Ensure transcript is sent even if the user closes the tab/navigates away
  useEffect(() => {
    const sendBeaconTrace = () => {
      if (!traceIdRef.current || transcriptRef.current.length === 0) return;
      // sendBeacon works even during page unload
      const blob = new Blob([JSON.stringify({
        traceId: traceIdRef.current,
        sessionId: sessionIdRef.current,
        transcript: transcriptRef.current,
        durationMs: Date.now() - sessionStartRef.current,
        usage: usageRef.current,
      })], { type: 'application/json' });
      navigator.sendBeacon('/api/voice-trace', blob);
      traceIdRef.current = null; // Prevent duplicate sends
    };

    window.addEventListener('beforeunload', sendBeaconTrace);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') sendBeaconTrace();
    });

    return () => {
      window.removeEventListener('beforeunload', sendBeaconTrace);
    };
  }, []);

  const stop = useCallback(() => {
    cleanup();
    setStatus('idle');
    setRemainingSeconds(SESSION_TIMEOUT_S);
  }, [cleanup]);

  const start = useCallback(async (history: Message[], sessionId: string, currentPage?: string) => {
    currentPageRef.current = currentPage || '';
    sessionIdRef.current = sessionId;
    setVoiceSources([]);
    if (!isSupported) {
      setError('unsupported');
      setStatus('error');
      return;
    }

    setStatus('connecting');
    setError(null);
    setTranscript([]);
    transcriptRef.current = [];
    setRemainingSeconds(SESSION_TIMEOUT_S);
    sessionStartRef.current = Date.now();
    currentTranscriptRef.current = '';
    usageRef.current = null;

    try {
      // 1. Get ephemeral token
      const tokenRes = await fetch('/api/voice-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });

      if (!tokenRes.ok) {
        const data = await tokenRes.json().catch(() => ({}));
        if (tokenRes.status === 429) {
          setError(data.error === 'rate_limited' ? 'rateLimited' : 'rateLimited');
          setStatus('error');
          return;
        }
        throw new Error(data.error || 'Failed to get voice token');
      }

      const { token, traceId } = await tokenRes.json();
      traceIdRef.current = traceId;
      addDebug(`Token: ${token ? 'OK' : 'MISSING'}`);

      if (!token) throw new Error('No token received');

      // 2. Request microphone access
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setError('micDenied');
        setStatus('error');
        return;
      }
      mediaStreamRef.current = stream;

      // 3. Set up audio capture
      const audioContext = new AudioContext({ sampleRate: INPUT_RATE });
      audioContextRef.current = audioContext;
      // Resume explicitly — user gesture may have expired after the awaits above
      if (audioContext.state === 'suspended') await audioContext.resume();
      addDebug(`AudioCtx in: ${audioContext.sampleRate}Hz → ${INPUT_RATE}Hz, state=${audioContext.state}`);

      const source = audioContext.createMediaStreamSource(stream);
      const inputAnalyserNode = audioContext.createAnalyser();
      source.connect(inputAnalyserNode);
      inputAnalyser.connect(inputAnalyserNode);

      // 4. Set up audio playback
      const playbackContext = new AudioContext({ sampleRate: OUTPUT_RATE });
      playbackContextRef.current = playbackContext;
      nextPlayTimeRef.current = 0;
      if (playbackContext.state === 'suspended') await playbackContext.resume();

      const outAnalyserNode = playbackContext.createAnalyser();
      outAnalyserNode.connect(playbackContext.destination);
      analyserNodeRef.current = outAnalyserNode;
      outputAnalyser.connect(outAnalyserNode);

      // 5. Connect WebSocket directly to the Gemini Live API.
      // The ephemeral token goes in an ordinary ?access_token= query param —
      // no subprotocol hack needed (OpenAI's Realtime API required one because
      // browsers can't set headers on a WebSocket). The ENTIRE session config
      // — model, system prompt, tools, transcription, voice — is locked into
      // the token server-side by api/voice-token.js, so this client sends an
      // empty setup and cannot override any of it.
      addDebug('Connecting WS to Gemini Live...');
      const ws = new WebSocket(LIVE_WS_URL(token));
      wsRef.current = ws;

      ws.onopen = () => {
        addDebug('WS connected — sending setup');
        ws.send(JSON.stringify({ setup: {} }));

        // Send prior text-chat history for continuity.
        if (history.length > 0) {
          const historyText = history
            .filter(m => m.content && m.content.trim())
            .map(m => `${m.role === 'user' ? 'User' : 'TJ'}: ${m.content}`)
            .join('\n');

          if (historyText) {
            ws.send(JSON.stringify({
              clientContent: {
                turns: [{
                  role: 'user',
                  parts: [{
                    text: `[Previous text conversation for context — do NOT repeat or reference this directly, just use it to maintain continuity]\n${historyText}`,
                  }],
                }],
                turnComplete: false,
              },
            }));
          }
        }
      };

      // Gemini Live delivers frames as Blob, so decoding needs an await — which
      // would let a later frame finish first and schedule its audio out of
      // order. Chain handling onto a promise so frames are processed strictly
      // in arrival order.
      let frameQueue: Promise<void> = Promise.resolve();

      ws.onmessage = (event) => {
        frameQueue = frameQueue.then(async () => {
          let raw = event.data;
          if (raw instanceof Blob) raw = await raw.text();
          else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);

          let data: Record<string, unknown>;
          try {
            data = JSON.parse(raw as string);
          } catch {
            return;
          }

          // Start audio capture only once the server acknowledges setup.
          if (data.setupComplete) {
            addDebug('setupComplete — starting audio capture');
            setStatus('listening');
            try {
              startAudioCapture(audioContext, source, ws);
              addDebug('Audio capture started OK');
            } catch (e) {
              addDebug(`Audio capture FAILED: ${e}`);
              console.error('Audio capture setup failed:', e);
            }

            // Start session timer
            timerRef.current = setInterval(() => {
              setRemainingSeconds(prev => {
                if (prev <= 1) {
                  stop();
                  return 0;
                }
                return prev - 1;
              });
            }, 1000);
          }

          handleLiveEvent(data, ws);
        }).catch((e) => console.error('[Voice] frame handling failed:', e));
      };

      ws.onerror = (e) => {
        console.error('Voice WebSocket error:', e);
        addDebug(`WS ERROR: ${(e as ErrorEvent).message || 'unknown'}`);
        setError('connection');
        setStatus('error');
        cleanup();
      };

      ws.onclose = (e) => {
        addDebug(`WS CLOSE: code=${e.code} reason=${e.reason || 'none'}`);
        // Use setStatus callback to check current status without stale closure
        setStatus(currentStatus => {
          if (currentStatus !== 'idle' && currentStatus !== 'error') {
            setTranscript(prev => {
              sendTrace(prev, sessionId);
              return prev;
            });
            cleanup();
            return 'idle';
          }
          return currentStatus;
        });
      };
    } catch (err) {
      console.error('Voice mode error:', err);
      addDebug(`CATCH: ${err instanceof Error ? err.message : String(err)}`);
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('error');
      cleanup();
    }
  }, [isSupported, cleanup, stop, inputAnalyser, outputAnalyser, sendTrace]);

  // PCM audio capture via ScriptProcessorNode (widely supported).
  // Target is INPUT_RATE (16 kHz) — Gemini Live's required input rate, which is
  // NOT the 24 kHz it sends back.
  function startAudioCapture(audioContext: AudioContext, source: MediaStreamAudioSourceNode, ws: WebSocket) {
    const actualRate = audioContext.sampleRate;
    const targetRate = INPUT_RATE;
    const resampleRatio = actualRate / targetRate; // e.g. 2.0 for 48kHz→24kHz
    const needsResample = Math.abs(resampleRatio - 1) > 0.01;

    addDebug(`Rate: ${actualRate}Hz → ${targetRate}Hz ${needsResample ? `(resample ${resampleRatio.toFixed(1)}x)` : '(native)'}`);

    // Use ScriptProcessorNode for broad compatibility
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    let chunkCount = 0;
    workletNodeRef.current = processor;

    source.connect(processor);
    // Connect to destination via silent GainNode (required for onaudioprocess to fire,
    // but we don't want to play mic audio back through speakers)
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    processor.onaudioprocess = (event) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      const inputData = event.inputBuffer.getChannelData(0);

      // Downsample to 24kHz if browser uses a different rate (common on iOS: 48kHz)
      let samples: Float32Array;
      if (needsResample) {
        const outLen = Math.floor(inputData.length / resampleRatio);
        samples = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) {
          // Linear interpolation for smoother resampling
          const srcIdx = i * resampleRatio;
          const idx0 = Math.floor(srcIdx);
          const idx1 = Math.min(idx0 + 1, inputData.length - 1);
          const frac = srcIdx - idx0;
          samples[i] = inputData[idx0] * (1 - frac) + inputData[idx1] * frac;
        }
      } else {
        samples = inputData;
      }

      // Convert Float32 to Int16
      const pcm16 = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      // Encode to base64
      const bytes = new Uint8Array(pcm16.buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);

      ws.send(JSON.stringify({
        realtimeInput: {
          audio: { data: base64, mimeType: `audio/pcm;rate=${INPUT_RATE}` },
        },
      }));
      chunkCount++;
      if (chunkCount === 1 || chunkCount % 30 === 0) {
        // Log RMS of first chunk and every ~5s to verify audio has signal
        let rms = 0;
        for (let i = 0; i < samples.length; i++) rms += samples[i] * samples[i];
        rms = Math.sqrt(rms / samples.length);
        addDebug(`chunk#${chunkCount} rms=${rms.toFixed(4)} len=${samples.length}`);
      }
    };
  }

  // Handle events from the Gemini Live API.
  //
  // The protocol differs from OpenAI Realtime in one way that matters for the
  // UI: there is NO server-side speech-START event. `activityStart`/`activityEnd`
  // are client→server messages for MANUAL activity detection and never come
  // back. Under automatic VAD the observable signals are, in arrival order:
  //   inputTranscription  → the user finished an utterance (our 'thinking' cue)
  //   inlineData audio    → the model is speaking
  //   generationComplete  → the model stopped generating
  //   turnComplete        → separate message, lags generationComplete by up to ~1.6s
  //   interrupted         → barge-in, fires the moment VAD trips mid-reply
  // Verified against a live session in the Phase 5b Test stage (plan §5.5).
  const handleLiveEvent = useCallback((data: Record<string, unknown>, ws: WebSocket) => {
    // --- usage accounting (exact, per-modality; may never arrive) ----------
    if (data.usageMetadata) {
      const u = data.usageMetadata as Record<string, unknown>;
      const modality = (list: unknown, want: string) =>
        (Array.isArray(list) ? list : []).reduce(
          (acc: number, d: Record<string, unknown>) =>
            acc + (d?.modality === want ? Number(d.tokenCount) || 0 : 0), 0);
      usageRef.current = {
        inputTokens: Number(u.promptTokenCount) || 0,
        outputTokens: Number(u.responseTokenCount) || 0,
        audioInputTokens: modality(u.promptTokensDetails, 'AUDIO'),
        audioOutputTokens: modality(u.responseTokensDetails, 'AUDIO'),
      };
    }

    // --- server-initiated disconnect ---------------------------------------
    if (data.goAway) {
      addDebug('goAway — server closing session');
      return;
    }

    // sessionResumptionUpdate arrives mid-turn with a resumption handle. At a
    // 120s cap there is nothing to resume, so it is deliberately ignored.

    // --- tool calls ---------------------------------------------------------
    if (data.toolCall) {
      const calls = (data.toolCall as Record<string, unknown>).functionCalls;
      for (const call of (Array.isArray(calls) ? calls : []) as Record<string, unknown>[]) {
        if (call.name === 'search_portfolio') {
          setStatus('thinking');
          setIsSearching(true);
          startThinkingSound();
          const args = (call.args || {}) as Record<string, unknown>;
          handleFunctionCall(String(call.id), String(args.query || ''), ws);
        }
      }
      return;
    }

    if (data.toolCallCancellation) {
      // The model gave up waiting on a tool result. Drop the pending UI state
      // rather than leaving the orb stuck in 'thinking'.
      addDebug('toolCallCancellation');
      setIsSearching(false);
      stopThinkingSound();
      return;
    }

    const sc = data.serverContent as Record<string, unknown> | undefined;
    if (!sc) return;

    // --- barge-in: server-signalled, replaces the old VAD-inferred teardown --
    if (sc.interrupted) {
      setDebugLog(prev => [...prev.slice(-9), 'INTERRUPTED (barge-in)']);
      stopThinkingSound();
      stopSubtitleLoop();
      currentTranscriptRef.current = '';
      if (pendingListenTimerRef.current) {
        clearTimeout(pendingListenTimerRef.current);
        pendingListenTimerRef.current = null;
      }
      // Closing the context is the only reliable way to drop already-scheduled
      // buffers; rebuild it immediately for the next turn.
      if (playbackContextRef.current) {
        playbackContextRef.current.close().catch(() => {});
        const newCtx = new AudioContext({ sampleRate: OUTPUT_RATE });
        playbackContextRef.current = newCtx;
        nextPlayTimeRef.current = 0;
        const outNode = newCtx.createAnalyser();
        outNode.connect(newCtx.destination);
        analyserNodeRef.current = outNode;
        outputAnalyser.connect(outNode);
      }
      setStatus('listening');
      return;
    }

    // --- user speech transcript --------------------------------------------
    const inputTx = sc.inputTranscription as Record<string, unknown> | undefined;
    if (inputTx?.text) {
      const userText = String(inputTx.text).trim();
      if (userText) {
        setTranscript(prev => [...prev, { role: 'user', text: userText }]);
        // The only "user finished talking" evidence this API gives us.
        setStatus('thinking');
        startThinkingSound();
      }
    }

    // --- assistant transcript (paces the subtitle loop) ---------------------
    const outputTx = sc.outputTranscription as Record<string, unknown> | undefined;
    if (outputTx?.text) {
      currentTranscriptRef.current += String(outputTx.text);
    }

    // --- assistant audio ----------------------------------------------------
    const parts = (sc.modelTurn as Record<string, unknown> | undefined)?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts as Record<string, unknown>[]) {
        const inline = part.inlineData as Record<string, unknown> | undefined;
        if (!inline?.data) continue;

        stopThinkingSound();
        setStatus('speaking');
        setIsSearching(false);

        const audioData = String(inline.data);
        if (playbackContextRef.current) {
          // PCM16 @ OUTPUT_RATE — 2 bytes/sample. Used to pace subtitles.
          const byteLen = Math.floor(audioData.length * 3 / 4);
          const chunkDuration = (byteLen / 2) / OUTPUT_RATE;
          if (totalAudioDurationRef.current === 0) {
            audioStartTimeRef.current = playbackContextRef.current.currentTime;
            startSubtitleLoop();
          }
          totalAudioDurationRef.current += chunkDuration;

          try {
            playAudioChunk(audioData, playbackContextRef.current);
          } catch (e) {
            console.warn('[Voice] Audio chunk playback error:', e);
          }
        }
      }
    }

    // --- the model stopped generating (audio may still be playing out) ------
    if (sc.generationComplete) {
      stopThinkingSound();
      const text = currentTranscriptRef.current.trim();
      if (text) {
        setTranscript(prev => [...prev, { role: 'assistant', text }]);
      }
      currentTranscriptRef.current = '';
      stopSubtitleLoop();
    }

    // --- turn over: return to listening once playback actually drains -------
    if (sc.turnComplete) {
      const pbCtx = playbackContextRef.current;
      if (pbCtx && nextPlayTimeRef.current > pbCtx.currentTime) {
        const delayMs = (nextPlayTimeRef.current - pbCtx.currentTime) * 1000;
        pendingListenTimerRef.current = setTimeout(() => {
          setStatus('listening');
          pendingListenTimerRef.current = null;
        }, delayMs + 150); // +150ms buffer for the audio tail
      } else {
        setStatus('listening');
      }
    }
  }, []);

  // Handle function calling (RAG search).
  // The tool result goes back as a `toolResponse` keyed by the call `id` — the
  // Live API resumes generation on its own, so unlike OpenAI Realtime there is
  // no follow-up "now continue" message to send.
  async function handleFunctionCall(callId: string, query: string, ws: WebSocket) {
    const reply = (output: string) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        toolResponse: {
          functionResponses: [{ id: callId, name: 'search_portfolio', response: { output } }],
        },
      }));
    };

    try {
      const res = await fetch('/api/rag-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, traceId: traceIdRef.current, currentPage: currentPageRef.current }),
      });

      const { context, sources } = await res.json();

      // Show source badges in voice UI
      if (sources?.length > 0) {
        setVoiceSources(sources);
      }

      reply(context || 'No relevant content found.');
    } catch {
      reply('Search temporarily unavailable — answer from your general knowledge.');
    }
  }

  // Play base64-encoded PCM Int16 audio
  function playAudioChunk(base64Audio: string, context: AudioContext) {
    const binary = atob(base64Audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const buffer = context.createBuffer(1, float32.length, OUTPUT_RATE);
    buffer.copyToChannel(float32, 0);

    const source = context.createBufferSource();
    source.buffer = buffer;

    // Connect through analyser for visualization
    if (analyserNodeRef.current) {
      source.connect(analyserNodeRef.current);
    } else {
      source.connect(context.destination);
    }

    // Schedule playback without gaps
    const now = context.currentTime;
    const startTime = Math.max(now, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + buffer.duration;
  }

  // Cleanup on unmount only — cleanup() uses refs internally so it always
  // accesses the latest state regardless of when it was captured.
  const cleanupRef = useRef(cleanup);
  cleanupRef.current = cleanup;
  useEffect(() => {
    return () => {
      cleanupRef.current();
    };
  }, []);

  return {
    state: {
      status,
      transcript,
      error,
      remainingSeconds,
      inputLevel: inputAnalyser.levelRef.current,
      outputLevel: outputAnalyser.levelRef.current,
    } as VoiceState,
    // Re-read levels directly from refs for animation frames
    getInputLevel: () => inputAnalyser.levelRef.current,
    getOutputLevel: () => outputAnalyser.levelRef.current,
    start,
    stop,
    isSupported,
    isSearching,
    liveTranscript,
    voiceSources,
    debugLog,
  };
}
