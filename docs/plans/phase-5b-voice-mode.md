# Phase 5b — Voice Mode

**Status:** Investigate ✅ done · Plan ⬜ not started · Test ⬜ · Implement ⬜

Goal: bring voice interaction to the chatbot, swapping the dormant OpenAI Realtime implementation for
Google's Live API, rewritten for TJ in English only.

---

## 1. Investigation findings

### The blocking research question is answered: this is a provider swap, not an architecture change

The roadmap flagged this as gated on an open question — does Google's Live API support the same
ephemeral-token / direct-browser-WebSocket model `useVoiceMode.ts` uses with OpenAI? **It does.** The
architecture survives intact:

| | OpenAI Realtime (current) | Gemini Live API (target) |
|---|---|---|
| Transport | Browser → `wss://api.openai.com/v1/realtime` | Browser → `wss://generativelanguage.googleapis.com/ws/...BidiGenerateContentConstrained` |
| Auth | Backend mints ephemeral token, browser connects direct | Same — backend `POST /v1beta/auth_tokens`, browser connects direct |
| Token delivery | WebSocket **subprotocol hack** (`openai-insecure-api-key.${token}`) | `?access_token=` **query param** |
| Backend proxies audio? | No | No |

So the existing shape — `api/voice-token.js` mints, browser holds the socket, `api/rag-search.js` serves the
tool call, `api/voice-trace.js` records — all stays. No audio proxying through `cv-chat-service`, no
rearchitecting. **This de-risks the phase substantially versus what the roadmap assumed.**

Two things get *better*, not just equivalent:

- **Token delivery is no longer a hack.** Browsers can't set headers on a `WebSocket`, which is why the
  current code passes the OpenAI key through the subprotocol list (`useVoiceMode.ts:362-365`) with a literal
  `openai-insecure-api-key.` prefix. Google accepts `?access_token=` as a query param — ordinary URL
  construction, no subprotocol negotiation to get wrong.
- **The prompt and tools can be locked server-side.** Token creation accepts `liveConnectConstraints`, pinning
  `model`, `config`, system instruction, and tools into the token itself so the client cannot alter them. The
  current OpenAI flow has the browser send its own `session.update` (`useVoiceMode.ts:371-391`) to configure
  VAD and transcription — a surface a hostile client could push on. Worth taking the constrained path
  deliberately; it strengthens the Phase 4 injection-defense posture rather than just preserving it.

Token lifetimes: `newSessionExpireTime` defaults to 1 minute to *open* a session, `expireTime` 30 minutes to
keep sending. Both comfortably exceed the current `SESSION_TIMEOUT_S = 120`.

### Audio formats are asymmetric — the current pipeline assumes they aren't

This is the single most concrete code change and the easiest thing to get silently wrong:

- **Gemini Live input:** raw 16-bit PCM, **16 kHz**, little-endian, sent as
  `{realtimeInput:{audio:{data,mimeType:"audio/pcm;rate=16000"}}}`
- **Gemini Live output:** raw 16-bit PCM, **24 kHz**, little-endian

The current code hardcodes **24 kHz on both sides**: two `AudioContext({sampleRate: 24000})`
(`useVoiceMode.ts:337, 349`), a `targetRate = 24000` in the capture resampler (`:478`), the barge-in context
rebuild (`:583`), and `context.createBuffer(1, len, 24000)` in playback (`:735`). Only the **capture** side
moves to 16000; playback stays 24000. The existing linear-interpolation resampler already handles arbitrary
ratios (48k→24k today, 48k→16k after), so it's a constant change, not new DSP — but the two rates must stop
being the same literal, or output plays back at the wrong pitch.

The Int16↔Float32 conversion, base64 encoding, gapless `nextPlayTime` scheduling, and the audio-synced
subtitle loop are all format-agnostic and carry over unchanged.

### The protocol event vocabulary is a full rewrite of `handleRealtimeEvent`

Every message name changes. `handleRealtimeEvent` (`useVoiceMode.ts:551-680`) is a switch over OpenAI event
types with no Google equivalent that maps 1:1:

| Current (OpenAI) | Gemini Live equivalent |
|---|---|
| `session.update` / `session.updated` | `setup` / `setupComplete` (or locked into the token) |
| `input_audio_buffer.append` | `realtimeInput.audio` |
| `input_audio_buffer.speech_started` / `_stopped` | `activityStart` / `activityEnd`; VAD via `automaticActivityDetection` (`startOfSpeechSensitivity`, `endOfSpeechSensitivity`, `prefixPaddingMs`, `silenceDurationMs`) |
| `conversation.item.input_audio_transcription.completed` | `serverContent.inputTranscription.text` (+ `interimInputTranscription`) |
| `response.audio.delta` | `serverContent.modelTurn.parts[].inlineData.data` |
| `response.audio_transcript.delta` / `.done` | `serverContent.outputTranscription.text` |
| `response.done` | `serverContent.turnComplete` |
| barge-in (manual context teardown) | `serverContent.interrupted` — server-signalled |
| `response.function_call_arguments.done` | `toolCall.functionCalls[]` |
| `conversation.item.create` + `function_call_output` + `response.create` | `toolResponse.functionResponses[]` (no explicit "continue" message) |
| — | `toolCallCancellation.ids[]` (no current equivalent — new case to handle) |

Two behavioral notes worth planning around:

- **Barge-in gets simpler.** Today the client infers interruption from `speech_started` and tears down /
  rebuilds the whole playback `AudioContext` (`:576-594`) to stop queued audio. Gemini sends an explicit
  `interrupted` flag; the teardown can be driven by that instead of by a VAD guess.
- **Transcription is opt-in.** Input and output transcription must be explicitly enabled in setup config, or
  the transcript stays empty — which would silently break both the subtitle UI and `voice-trace.js`'s entire
  jailbreak/fingerprint scan, since that operates purely on transcript text.

### `RagSource` in `useVoiceMode.ts` is already broken — a live bug, not a translation task

`useVoiceMode.ts:25-34` declares:

```ts
page_path_en, page_path_es, article_slug_en, article_slug_es
```

But `_shared/rag.js` (rewritten in Phase 2) returns single-path `page_path` / `article_slug`
(`rag.js:223-224`, `HOME_SOURCE` at `:253-258`). `FloatingChat.tsx:39-45` already has the correct
single-path type. So voice source badges read `undefined` for every link today. This is a pre-existing
casualty of the Phase 2 bilingual removal that nothing caught, because voice is unrouted and its evals are
deferred. Fix is to delete the type and import the shared one — but it means "the dormant code works, it just
speaks Spanish" is **not** true.

### Bilingual coupling is narrower than the roadmap estimated

The roadmap describes `lang` as "threaded through every function," comparable to the `i18n.ts` surgery in
Phase 2. The actual audit is smaller: 14 `lang` references in `useVoiceMode.ts`, and it's almost entirely
**pass-through plumbing** — `start(history, lang, sessionId, currentPage)` forwards it to the token request
and the trace, and `handleRealtimeEvent` / `handleFunctionCall` take it as a parameter they never read
(already `_lang` in the latter). Removing it is deleting a parameter from a call chain, not restructuring
logic.

The real bilingual weight is in **prompt text**, not control flow:

- `voice-token.js` — `VOICE_AFFECT_ES` / `VOICE_AFFECT_EN` (two blocks, Santiago's Seville/Peninsular-Spanish
  persona) + `VOICE_BASE_PROMPT` (~60 lines, entirely Spanish, Santiago's projects, `hi@santifer.io`,
  `linkedin.com/in/santifer`, `github.com/santifer/cv-santiago`). Full rewrite for TJ, one English block.
- `rag-search.js:33` — `VOICE_OVERRIDE`, one Spanish line naming Santiago in first person. One-line rewrite.
- `voice-token.js` — the 429 rate-limit message branches on `lang`. Collapses to one English string.

### `VoiceOrb.tsx` and `useAudioAnalyser.ts` are genuinely free

Confirmed by reading them: `VoiceOrb`'s props are `status`, `getInputLevel`, `getOutputLevel`,
`remainingSeconds`, `transcript`, `statusText`, `isMobile` — no provider, no language, no content. It reads
theme colors from CSS vars and honors `prefers-reduced-motion`. `useAudioAnalyser` (71 lines) is a generic
`AnalyserNode` RMS wrapper. Both carry over untouched. `statusText` being an injected prop is what kept it
language-clean.

### Production would 404 — the exact Phase 5a gap, caught this time in Investigate

`cv-ui/api/` contains only `chat.js` and `ops/[...path].js`. There is **no route for `/api/voice-token`,
`/api/voice-trace`, or `/api/rag-search`.** All three are called same-origin from the browser
(`useVoiceMode.ts:236, 264, 305, 685`), so all three 404 in production exactly as `/api/ops/*` did before
Phase 5a fixed it.

Phase 5a's own post-mortem (`phase-5a-ops-dashboard.md` §3.5, §7) named this as a known outstanding gap. It
needs a thin proxy following the established pattern — `CHAT_SERVICE_URL` from env, never hardcoded, never a
static `vercel.json` rewrite. Open design question for the Plan stage: whether `/api/voice-*` + `/api/rag-search`
warrant one catch-all or individual proxies, and whether they take the `CHAT_SERVICE_SECRET` injection that
`/api/chat` gets (`rag-search.js` has no auth check today — worth deciding deliberately, since it's an
LLM-billing endpoint reachable by anyone).

### CSP will silently block the connection — prod-only, invisible in dev

`cv-ui/vercel.json`'s `connect-src` hardcodes `wss://api.openai.com https://api.openai.com`. Pointing the
socket at Google without updating this means the browser blocks the WebSocket with a console CSP violation
and no application-level error — and Vite's dev server doesn't apply `vercel.json` headers at all, so **local
testing cannot catch it.** Same failure shape as the `404.html` bug that escaped Phase 5a's "full"
verification.

Needs `wss://generativelanguage.googleapis.com https://generativelanguage.googleapis.com`, with the OpenAI
entries removed once nothing uses them. `Permissions-Policy: microphone=(self)` is already correct — no
change needed there.

### Local dev has no voice routes

`scripts/dev-server.mjs`'s route table (`:31-38`) covers `/api/chat` and `/api/ops/*` only — its own comment
says `/api/voice-*.js` is deliberately unwired. Needs three entries. This also unblocks
`evals/datasets/voice.json` (6 tests), which targets `/api/rag-search` and has been failing/erroring since
Phase 4 purely because the route doesn't resolve locally.

### Other loose ends found

- **`voice-trace.js` pricing is OpenAI's** — hardcoded `$0.06/min` input, `$0.24/min` output (`:65-71`),
  with a crude 40/60 duration split. Gemini Live bills by **token**, not minute (~32 tokens per second of
  audio), so this becomes a different calculation, not a different constant. Everything else in that file
  (`classifyIntent`, `containsFingerprint`, `sendJailbreakAlert`, Langfuse trace update) is provider-agnostic
  and reusable as-is.
- **`voice_rate_limits` Supabase table may not exist.** `checkRateLimit` fails *open* if the table is missing
  (`voice-token.js:50-53`), so an unprovisioned table means unlimited voice sessions with no error. Not in
  `scripts/supabase-setup.sql` — needs adding, and now needs RLS enabled like `documents`.
- **`FloatingChat.tsx` has zero voice references** — confirmed by grep. Fully unwired, as the roadmap says.
  All UI entry points (mic button, orb mount, mode switching, source badges) are new work.
- **`/ops` already renders voice data** — `ConversationList.tsx:40`, `ConversationDetail.tsx:32,179`, and
  `api/ops/stats.js:75-125` all branch on a `voice` trace tag that nothing currently produces. These light up
  for free once voice traces start flowing; no dashboard work needed.

---

## 2. Decisions

Carried forward into Plan:

1. **Keep the direct-browser-WebSocket architecture.** Confirmed supported; no audio proxying.
2. **Use the constrained/ephemeral-token endpoint and lock model + system instruction + tools server-side**
   via `liveConnectConstraints`, rather than reproducing the client-sends-`session.update` pattern.
3. **Rewrite `handleRealtimeEvent` against the Gemini vocabulary** rather than building a translation shim —
   a shim would preserve OpenAI's turn model where Google's differs (server-signalled `interrupted`,
   `toolCallCancellation`).
4. **Delete `lang` outright** rather than defaulting it to `'en'` — matches the Phase 2/4/5a precedent.
5. **Import the shared single-path `RagSource`** instead of maintaining a second copy in `useVoiceMode.ts`.

Open for Plan:

- One catch-all `cv-ui/api/voice/[...path].js` vs. three thin proxies; whether `/api/rag-search` gets
  `CHAT_SERVICE_SECRET` injection and/or its own rate limit.
- Which Live API model (native-audio vs half-cascade) — affects voice quality, tool-calling reliability, and
  cost; needs a Test-stage comparison, not a docs decision.
- Whether the 120s session cap and 3-sessions-per-IP/day limit still suit Gemini's cost profile.

## 3. Plan

Not yet written — Plan stage hasn't started.

## 4. Test stage

Not started. Highest-risk items to validate with scratch scripts before implementing: (a) a real ephemeral
token minted with `liveConnectConstraints` actually connecting from a browser and honoring the locked prompt;
(b) the 16 kHz-in / 24 kHz-out split sounding correct end-to-end; (c) `toolCall` → `toolResponse` round-trip
against the real `/api/rag-search`.
