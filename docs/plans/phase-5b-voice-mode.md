# Phase 5b — Voice Mode

**Status:** Investigate ✅ done · Plan ✅ done · Test ✅ done · Implement ✅ done

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
  current code passes the OpenAI key through the subprotocol list (`useVoiceMode.ts:365-367`) with a literal
  `openai-insecure-api-key.` prefix. Google accepts `?access_token=` as a query param — ordinary URL
  construction, no subprotocol negotiation to get wrong.
- **The prompt and tools can be locked server-side.** Token creation accepts `liveConnectConstraints`, pinning
  `model`, `config`, system instruction, and tools into the token itself so the client cannot alter them. The
  current OpenAI flow has the browser send its own `session.update` (`useVoiceMode.ts:371-389`) to configure
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
(`useVoiceMode.ts:339, 351`), a `targetRate = 24000` in the capture resampler (`:479`), the barge-in context
rebuild (`:571`), and `context.createBuffer(1, len, 24000)` in playback (`:738`). Only the **capture** side
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
  rebuilds the whole playback `AudioContext` (`:568-577`) to stop queued audio. Gemini sends an explicit
  `interrupted` flag; the teardown can be driven by that instead of by a VAD guess.
- **Transcription is opt-in.** Input and output transcription must be explicitly enabled in setup config, or
  the transcript stays empty — which would silently break both the subtitle UI and `voice-trace.js`'s entire
  jailbreak/fingerprint scan, since that operates purely on transcript text.

### `RagSource` in `useVoiceMode.ts` is already broken — a live bug, not a translation task

`useVoiceMode.ts:25-33` declares:

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

`scripts/dev-server.mjs`'s route table (`:31-39`) covers `/api/chat` and `/api/ops/*` only — its own comment
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
  (`voice-token.js:51-54`), so an unprovisioned table means unlimited voice sessions with no error. Not in
  `scripts/supabase-setup.sql` — needs adding, and now needs RLS enabled like `documents`.
- **`FloatingChat.tsx` has zero voice references** — confirmed by grep. Fully unwired, as the roadmap says.
  All UI entry points (mic button, orb mount, mode switching, source badges) are new work.
- **`/ops` already renders voice data** — `ConversationList.tsx:40`, `ConversationDetail.tsx:32,179`, and
  `api/ops/stats.js:75-125` all branch on a `voice` trace tag that nothing currently produces. These light up
  for free once voice traces start flowing; no dashboard work needed.

---

## 2. Decisions

Settled during Plan:

1. **Keep the direct-browser-WebSocket architecture.** Confirmed supported; no audio proxying through
   `cv-chat-service`.
2. **Use the constrained endpoint** (`...BidiGenerateContentConstrained?access_token=`) and lock `model`,
   `systemInstruction`, and `tools` into the token server-side via `liveConnectConstraints`, rather than
   reproducing OpenAI's client-sends-`session.update` pattern. The prompt then never reaches the browser and
   can't be overridden by a hostile client.
3. **Rewrite `handleRealtimeEvent` against the Gemini vocabulary** rather than building a translation shim.
4. **Delete `lang` outright** rather than defaulting it to `'en'` — matches the Phase 2/4/5a precedent.
5. **Import the shared single-path `RagSource`** instead of maintaining a second copy in `useVoiceMode.ts`.
6. **Model: `gemini-3.1-flash-live-preview`** — decided by elimination, not preference. The half-cascade Live
   models (`gemini-live-2.5-flash-preview`) that were the recommended choice for tool-heavy flows were
   deprecated and pulled from the docs in 2026; native audio is the only remaining option on the Live API.
   This matters because **native-audio models are the weaker tool callers** — the exact capability this
   design depends on — so §5 treats that as the top Test-stage risk rather than an implementation detail.
7. **Three thin proxies sharing one helper**, not a catch-all. A `[...path].js` catch-all only matches within
   its own directory, and the three endpoints (`/api/voice-token`, `/api/voice-trace`, `/api/rag-search`)
   don't share a prefix. Renaming them to `/api/voice/*` to enable a catch-all would churn
   `dev-server.mjs`, `evals/runner.ts`, and `voice.json` for cosmetics.
8. **All three endpoints get `CHAT_SERVICE_SECRET`**, injected by the proxy exactly as `api/chat.js` does.
   `rag-search.js` has no auth today despite billing Anthropic + Gemini + Supabase on every call — closing
   that is part of this phase, not a follow-up. `evals/runner.ts:170-177` already sends the header, so the
   eval suite needs no change.

Deferred to Test stage (§5) — genuinely can't be answered from docs:

- Whether native-audio tool calling is reliable enough to carry the anti-hallucination guarantee.
- Which `toolResponse` wire shape is correct (Google's own docs disagree — see §3.2).
- How to drive the orb's `listening`/`thinking` state transitions under Gemini's automatic VAD (see §3.3).
- Which prebuilt voice suits TJ.

---

## 3. Plan

### 3.1 Token minting — `cv-chat-service/api/voice-token.js`

Rewrite the OpenAI session-create call as a Gemini ephemeral-token mint:

```
POST https://generativelanguage.googleapis.com/v1beta/auth_tokens?key=$GOOGLE_API_KEY
{
  "uses": 1,
  "expireTime":           <now + 20 min>,
  "newSessionExpireTime": <now + 1 min>,
  "bidiGenerateContentSetup": {
    "model": "models/gemini-3.1-flash-live-preview",
    "generationConfig": {
      "responseModalities": ["AUDIO"],
      "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Charon" } } }
    },
    "systemInstruction": { "parts": [{ "text": VOICE_PROMPT }] },
    "tools": [{ "functionDeclarations": [SEARCH_PORTFOLIO] }],
    "inputAudioTranscription": {},
    "outputAudioTranscription": {}
  }
}
```

> **Corrected in Test.** The plan originally wrote `liveConnectConstraints` with `responseModalities` at the
> setup top level, taken from Google's docs. Both are wrong on the wire: the REST field is
> **`bidiGenerateContentSetup`** (the docs name `LiveConnectConstraints`, which is the *Python SDK* type),
> and `responseModalities`/`speechConfig` must sit inside **`generationConfig`**. The API rejects the
> documented spelling with `Unknown name "liveConnectConstraints"`. Verified in `01b`/`01c`.

Returns `{ token: <token.name>, traceId, expiresAt }` — same response contract the client already consumes
(`useVoiceMode.ts:321`), so the client-side token plumbing is unchanged.

Notes:
- `GOOGLE_API_KEY` already exists in `cv-chat-service/.env.local` (used by RAG embeddings) — no new secret.
  The `OPENAI_API_KEY` guard at `voice-token.js:195` becomes a `GOOGLE_API_KEY` guard, and `OPENAI_API_KEY`
  can then be dropped from the service entirely, since `voice-trace.js` only used it for pricing constants.
- Enabling both transcription fields is **not optional decoration**: `voice-trace.js`'s entire
  jailbreak/fingerprint scan operates on transcript text. Omit them and the Phase 4 defense layer silently
  becomes a no-op on voice.
- Add the `CHAT_SERVICE_SECRET` bearer check at the top, copying `api/chat.js:53-59`.

### 3.2 Client protocol rewrite — `cv-ui/src/useVoiceMode.ts`

**Connection** (replaces `:365-367`): build `wss://generativelanguage.googleapis.com/ws/
google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${token}`
— an ordinary URL, no subprotocol array. Because the config is locked into the token, `ws.onopen` sends
**only** `{"setup":{}}` (or the minimum the constrained endpoint requires) instead of the current
`session.update` block; wait for `setupComplete` before starting capture, mirroring today's wait on
`session.updated` (`:418`).

**Conversation history injection** (`:392-411`): the current text-history handoff maps to
`clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: false }`. Keep the existing
"[Previous text conversation for context…]" framing; swap `Santiago:` for `TJ:` in the transcript rendering.

**Event handling** — rewrite the `handleRealtimeEvent` callback (`:551-680`) against:

| Handle | Gemini message |
|---|---|
| setup ack | `setupComplete` |
| user transcript | `serverContent.inputTranscription.text` |
| assistant audio | `serverContent.modelTurn.parts[].inlineData.data` |
| assistant transcript | `serverContent.outputTranscription.text` |
| turn end | `serverContent.turnComplete` |
| barge-in | `serverContent.interrupted` — replaces the VAD-inferred teardown at `:568-577` |
| tool call | `toolCall.functionCalls[]` (`{id, name, args}`) |
| tool cancel | `toolCallCancellation.ids[]` — **new case**, no current equivalent |

**Tool response — resolved in Test.** Use the `toolResponse` form; the docs' other spelling is not needed:

```jsonc
// server →   {"toolCall":{"functionCalls":[{"name":"search_portfolio","args":{"query":"…"},"id":"fc_1204…"}]}}
// client →   {"toolResponse":{"functionResponses":[{"id":"fc_1204…","name":"search_portfolio",
//                                                   "response":{"output":"<context string>"}}]}}
```

Confirmed against a live session: the model resumes on its own and the spoken answer is grounded in the
supplied context, so the explicit `response.create` "now continue" message (`:709`, `:720`) is deleted with no
replacement. Keep the `id` — it is what matches concurrent calls, and it is what `toolCallCancellation`
cancels.

`handleFunctionCall` (`:683-723`) keeps its shape: same `/api/rag-search` fetch, same `setVoiceSources`,
same error-path fallback string. Only the two `ws.send` payloads change.

**Type fix:** delete the local `RagSource` (`:25-33`) and import the single-path one. Cleanest is to lift
`FloatingChat.tsx:39-45`'s definition into a shared `cv-ui/src/types.ts` and import it in both, so this
can't drift a third time.

**Delete `lang`:** remove the parameter from `start`, `sendTrace`, `handleRealtimeEvent`, `handleFunctionCall`,
`langRef`, and the `/api/voice-token` + `/api/voice-trace` request bodies. 14 references, all pass-through.

### 3.3 Audio pipeline — 16 kHz in / 24 kHz out

Five sites currently hardcode 24000. Split them:

| Site | Now | After |
|---|---|---|
| `:339` capture `AudioContext` | 24000 | **16000** |
| `:479` `targetRate` in resampler | 24000 | **16000** |
| `:351` playback `AudioContext` | 24000 | 24000 (unchanged) |
| `:571` barge-in context rebuild | 24000 | 24000 (unchanged) |
| `:738` `createBuffer(1, len, …)` | 24000 | 24000 (unchanged) |

Introduce `const INPUT_RATE = 16000` and `const OUTPUT_RATE = 24000` so the two can never collapse back into
one literal. The existing linear-interpolation resampler handles 48k→16k with no change beyond the constant.
The send payload becomes
`{realtimeInput:{audio:{data: <base64>, mimeType:"audio/pcm;rate=16000"}}}` (replacing
`input_audio_buffer.append` at `:535-538`). Int16↔Float32 conversion, base64 encoding, gapless
`nextPlayTime` scheduling, and the subtitle loop are all format-agnostic and carry over untouched.

**Orb state machine — resolved in Test.** The concern was real: under automatic activity detection there is
**no server-side speech-start event at all**. `activityStart`/`activityEnd` are client→server messages for
*manual* mode and never come back. The observable signals, in the order they actually arrive, are:

| Transition | Signal |
|---|---|
| → `listening` | session ready (`setupComplete`), or `turnComplete` after a reply |
| user is talking | first `serverContent.inputTranscription.text` — the only "user spoke" evidence when idle |
| user interrupts mid-reply | `serverContent.interrupted` — fires as soon as VAD trips, *before* the utterance is transcribed |
| → `thinking` | after `realtimeInput.audioStreamEnd`, until the first output arrives |
| → `speaking` | first `modelTurn.parts[].inlineData` chunk |
| model finished generating | `serverContent.generationComplete` |
| → back to `listening` | `serverContent.turnComplete` (a **separate** message right after `generationComplete`; measured up to ~1.6 s later) |

So `interrupted` replaces today's VAD-inferred barge-in teardown (`:568-577`) exactly, but the idle-state
`listening`→`thinking` transition must be derived from transcription arrival rather than a VAD event. Prefer
`generationComplete` over `turnComplete` for "stop the thinking pips", and keep the existing
`nextPlayTime`-based wait (`:635-645`) for when playback actually finishes — `turnComplete` lags real audio.

Two message types the plan didn't account for, both harmless but worth handling explicitly rather than
falling through a `default`:
- `sessionResumptionUpdate` — carries a resumption handle; ignorable at a 120 s cap, but it arrives mid-turn.
- `goAway` — server-initiated disconnect warning. Worth surfacing as a clean session end rather than an error.

### 3.4 Prompt rewrite — TJ, English only

- **`voice-token.js`**: delete `VOICE_AFFECT_ES`, `VOICE_AFFECT_EN`, and `VOICE_BASE_PROMPT`. Write one
  English `VOICE_PROMPT` for TJ, carrying over the *structure* that works (brevity cap, no-markdown rule,
  search-when-in-doubt rule, badge awareness, factual guardrails, anti-extraction, boundary handling) while
  replacing all content. Real contact details, per the Phase 2 lesson where a draft prompt hallucinated a
  plausible fake email when the real one was injected dynamically — bake it in statically.
- Subject to the **content-sensitivity rule**: Apple / SAP BTP / Cloud Foundry nameable; internal tool names
  and ticket numbers generalized. Mirror `cv-chat-service/chatbot-prompt.txt`'s framing.
- **`rag-search.js:33`**: rewrite the one-line Spanish `VOICE_OVERRIDE` in English, first person as TJ.
- **`voice-token.js`** rate-limit 429: collapse the ES/EN branch to one English string.
- **Fingerprint sync:** `PROMPT_FINGERPRINTS` in `_shared/rag.js` matches phrases from `chatbot-prompt.txt`.
  If the new voice prompt introduces distinctive phrases worth leak-detecting, add them — otherwise the
  voice prompt is invisible to the fingerprint layer. Decide explicitly rather than by omission.

### 3.5 Transport and routing — the two production-only gaps

**Proxies.** Add `cv-ui/api/_shared/proxy.js` exporting a `forwardToChatService(req, path)` helper
(`CHAT_SERVICE_URL` + `CHAT_SERVICE_SECRET` from env, `Authorization: Bearer`, stream-through response, the
same misconfiguration guard and 502 handling as `api/chat.js`). Then three ~6-line handlers:
`cv-ui/api/voice-token.js`, `cv-ui/api/voice-trace.js`, `cv-ui/api/rag-search.js`. Underscore-prefixed dirs
are already proven ignored-by-Vercel in this repo (`cv-chat-service/api/_shared/`).

`voice-trace` must tolerate `navigator.sendBeacon` (`:264`), which POSTs a `Blob` during page unload —
body-as-text forwarding handles it, but don't add a `Content-Type` assertion that would reject it.

**CSP.** In `cv-ui/vercel.json`, replace `wss://api.openai.com https://api.openai.com` in `connect-src` with
`wss://generativelanguage.googleapis.com https://generativelanguage.googleapis.com`. This is the highest-risk
line in the phase: Vite does not apply `vercel.json` headers, so a mistake here is invisible locally and
surfaces only as a silent browser-level block in production — the same failure shape as the Phase 5a
`404.html` bug. `Permissions-Policy: microphone=(self)` is already correct; leave it.

**Local dev.** Add three entries to `scripts/dev-server.mjs`'s route table (`:31-39`):
`/api/voice-token`, `/api/voice-trace`, `/api/rag-search`. Update the comment at `:27-30` that currently
documents them as deliberately unwired. Vite's proxy already forwards all `/api/*` and injects the secret
only for `/api/chat` (`vite.config.ts`) — extend that condition to the three new paths, since they now
expect the secret too.

### 3.6 Observability and cost — `voice-trace.js`

Replace the OpenAI per-minute estimate (`:65-71`) — but **not** with the token estimate the plan first
proposed. Test showed the API reports actual usage: a `usageMetadata` message carries `promptTokenCount`,
`responseTokenCount`, `totalTokenCount` and a `promptTokensDetails` / `responseTokensDetails` breakdown
**split by modality** (`TEXT` vs `AUDIO`). That is exact, so use it instead of deriving cost from duration or
from ~32 tokens/second.

One caveat found in Test: `usageMetadata` is **not guaranteed to arrive before the session ends** — it landed
promptly in some runs and not within 12 s in another. So the client should accumulate it whenever it appears
and post it with the trace, falling back to the duration estimate only when none was received. Otherwise a
short or abandoned session records zero cost.

Keep the existing structure — `classifyIntent`, `containsFingerprint`, `sendJailbreakAlert`, the Langfuse
`trace.update` + `trace.generation` calls, and the `cost.{audioInput,audioOutput,voice,total}` metadata shape
that `/ops` already reads. Drop `lang` from the tag set (`:45`), matching the Phase 5a removal.

No `/ops` work is needed: `ConversationList.tsx:40`, `ConversationDetail.tsx:32,179`, and
`api/ops/stats.js:75-125` already branch on the `voice` trace tag and light up once traces flow.

### 3.7 Supabase — `voice_rate_limits`

Add the table to `scripts/supabase-setup.sql`; it was never there, and `checkRateLimit` fails **open**
(`voice-token.js:51-54`), so today an absent table means unlimited voice sessions with no error. Enable RLS
with zero policies, matching the `documents` decision — `voice-token.js` uses the service-role key, which
bypasses RLS. Revoke `EXECUTE`/table grants from `anon`/`authenticated` so the rate-limit counter isn't
publicly writable.

Reconsider the limits themselves against Gemini's cost profile: `MAX_SESSIONS_PER_IP = 3`/day and
`SESSION_TIMEOUT_S = 120` were sized for OpenAI Realtime pricing. The Live API caps audio-only sessions at
15 minutes, so 120s remains a deliberate cost choice, not a platform constraint.

### 3.8 UI wiring — `cv-ui/src/FloatingChat.tsx`

All new work; zero existing references. Needs: a mic entry point in the chat header, `VoiceOrb` mounted in a
voice view, mode switching between text and voice, `statusText` strings supplied in English (the prop that
kept `VoiceOrb` language-clean), source badges rendered from `voiceSources` reusing the existing badge
component at `:705`, and error surfaces for `micDenied` / `rateLimited` / `unsupported` / `connection`.
Pass existing text history into `start()` so voice picks up conversational context.

`VoiceOrb.tsx` and `useAudioAnalyser.ts` need **no changes** — verified provider-, language-, and
content-free.

### 3.9 Evals

`evals/datasets/voice.json` (6 tests) has been failing since Phase 4 only because `/api/rag-search` had no
local route; §3.5 fixes that. Re-run and rewrite assertions for TJ — they still assert Santiago-era content.
Expect the same class of test-authoring bugs Phase 4 hit: read the actual responses before concluding a
failure is a defect. Regenerate the `/ops` Evals tab afterward (`npx tsx scripts/embed-evals.ts`), since the
committed snapshot's total will change from 50.

### 3.10 Not in scope

- Case-study articles / populating `ARTICLE_KEYWORDS` + `ARTICLE_ROUTES` (unchanged from Phase 4's reasoning).
- CI (no pipeline exists in this repo).
- Headshot, domain, `prompt:sync` — tracked as roadmap deferrals, unrelated to voice.
- Video input. Live API supports it; nothing in this CV calls for it, and it would cut sessions to 2 minutes.

---

## 4. Suggested commit order

1. `chore(voice): add voice_rate_limits table + RLS to supabase-setup.sql`
2. `fix(voice): correct stale bilingual RagSource type, share it with FloatingChat` — standalone bug fix,
   valid independently of the provider swap
3. `feat(voice): mint Gemini Live ephemeral tokens with server-locked prompt and tools` (§3.1 + §3.4 prompts)
4. `feat(voice): rewrite client for the Gemini Live protocol` (§3.2 + §3.3)
5. `feat(voice): add cv-ui proxies for voice endpoints, update CSP and dev routes` (§3.5)
6. `feat(voice): switch cost tracking to Gemini per-token pricing` (§3.6)
7. `feat(voice): wire voice mode into FloatingChat` (§3.8)
8. `test(voice): rewrite voice evals for TJ and regenerate ops snapshot` (§3.9)
9. `docs: mark Phase 5b done in roadmap and READMEs`

Commits 1 and 2 are safe to land before Test concludes. 3-5 should follow the Test-stage findings, since §5
can invalidate parts of §3.2.

---

## 5. Test stage ✅ Done

Validated with dependency-free scratch scripts in `process/scratch/phase-5b/` (git-ignored) against the real
Gemini Live API using the existing `GOOGLE_API_KEY`. Real speech was generated with macOS `say`
(`--data-format=LEI16@16000`), which emits exactly the 16 kHz mono LEI16 PCM the API requires — no TTS
dependency needed.

### 5.1 Tool-calling reliability ✅ **10/10 — risk cleared**

The phase's biggest unknown. Ten spoken portfolio questions, one fresh session each, real audio streamed at
realtime pace: `gemini-3.1-flash-live-preview` called `search_portfolio` on **every one (100%)**, and input
transcription was accurate on every one. The community reports of native-audio tool-calling regression do not
reproduce on this model — they appear to concern the 2.5-era native-audio models. No fallback architecture is
needed and §3 stands as written. (`05-toolcall-rate.mjs`)

The model list also confirmed the Investigate finding empirically: this key sees seven `bidiGenerateContent`
models, **none of them half-cascade**. (`00-list-models.mjs`)

### 5.2 Tool-response wire shape ✅ resolved

`toolResponse.functionResponses[{id, name, response}]` is correct; `toolCall.functionCalls[]` supplies
`{name, args, id}`. The model resumed on its own and answered from the injected context, confirming no
"continue" message is needed. §3.2 updated with the verbatim shapes. (`03-toolcall.mjs`)

### 5.3 Ephemeral token + server-side lock ✅ works — with two corrections

A plain `WebSocket` to `…BidiGenerateContentConstrained?access_token=<token>` connects with no custom headers,
so it is browser-compatible as designed. The client sent only `{setup:{}}`; a canary phrase placed **only** in
the token's locked `systemInstruction` came back in the reply, proving the lock applies and the prompt never
needs to touch the browser.

Two documented field names were wrong on the wire and are corrected in §3.1 — `bidiGenerateContentSetup`
(not `liveConnectConstraints`) and `responseModalities` nested inside `generationConfig`. Both were rejected
outright by the API, so this would have failed on first run. (`01-mint-token.mjs`, `01b`, `01c`, `02-connect.mjs`)

### 5.4 Audio format split ✅ confirmed

Input at 16 kHz was accepted and transcribed accurately. Output arrived tagged `audio/pcm;rate=24000` on every
chunk. 18.33 s of captured output audio decoded as valid 24 kHz mono Int16 with healthy levels (peak 29406,
mean abs 2002) — correct pitch, not the 27.5 s a 16 kHz misread would produce. The asymmetric split in §3.3 is
right. (`06-vad-and-audio.mjs`, `out-24k.wav`)

### 5.5 VAD / orb state machine ✅ resolved — the concern was real

There is **no server-side speech-start event**. Barge-in *does* produce `serverContent.interrupted`, firing as
soon as VAD trips and before the interrupting utterance is transcribed. `turnComplete` arrives as a separate
message after `generationComplete`, lagging it by up to ~1.6 s. Full signal table now in §3.3.
(`06-vad-and-audio.mjs`)

### 5.6 Voice audition ✅ **Charon** chosen

Six candidates rendered to WAV at `process/scratch/phase-5b/voice-<name>.wav`: **Puck, Charon, Kore, Fenrir,
Aoede, Orus**, each speaking a TJ intro line. Needs a listen and a pick before §3.1's `voiceName` is filled in.
This is the only Test item that can't be settled programmatically. (`07-voice-audition.mjs`)

### Unplanned findings worth carrying into Implement

- **`usageMetadata` gives exact per-modality token counts**, making §3.6's duration-based estimate obsolete —
  but it isn't guaranteed to arrive before a session ends, so it needs an accumulate-and-fallback treatment.
- **`sessionResumptionUpdate` and `goAway`** are real message types the plan never accounted for; both should
  be handled explicitly rather than silently ignored.

### Carry into Implement as tests

Per the repo workflow, the scratch work is adapted rather than discarded. `_audio.mjs` (say → 16 kHz PCM),
`_session.mjs` (raw WS harness), and the ten spoken questions in `05-toolcall-rate.mjs` become the basis of a
voice integration test — the tool-call rate in particular is a regression check worth keeping, since it is the
one behavior the whole design leans on.

---

## 6. Implementation ✅ Done

Built as planned in §3, with the §5 corrections folded in. Commit order followed §4.

### Corrections the Test stage had already caught

`api/voice-token.js` uses `bidiGenerateContentSetup` (not the documented `liveConnectConstraints`) with
`responseModalities`/`speechConfig` nested inside `generationConfig`. Both were hard 400s. Voice is **Charon**.

### Found during Implement

- **`chatbot-prompt.txt` explicitly instructed the text bot to deny that voice exists** — a "No voice mode
  (IMPORTANT — do not contradict this)" block telling it to say "Text only for now." Nothing in Investigate or
  Plan flagged it, because the search was for *voice code*, not for prose asserting voice's absence. Replaced
  with an accurate block that points at the mic button and names the right model per surface (Gemini Live for
  voice, Claude for text).
- **`PROMPT_FINGERPRINTS` covered only the text prompt.** The Phase 4 fingerprint layer matches phrases from
  `chatbot-prompt.txt`; a leaked *voice* prompt would have passed straight through it. Added four phrases
  unique to the voice prompt. The plan flagged this as a decision to make explicitly rather than by omission
  (§3.4) — this is that decision.
- **The `auth_tokens` response carries only `name`.** The first draft returned `expiresAt: data.expireTime`,
  which is always `undefined`. Now echoes back the expiry actually requested.
- **`usageMetadata` beat the plan's own cost model.** §3.6 originally proposed deriving cost from ~32
  tokens/second; Test found the API reports exact per-modality counts. Implemented as accumulate-and-fallback,
  since that message is not guaranteed to arrive before a session ends.

### The eval rewrite was a bigger correction than scoped

§3.9 assumed `voice.json` just needed Santiago's content swapped for Taher's. Three of its six tests
(`voice-no-markdown`, `voice-no-urls`, `voice-brevity-general`) asserted **spoken-output** properties against
`/api/rag-search`, which returns *retrieval context* — and which deliberately falls back to raw markdown
chunks when RAG exceeds 1500 ms. Those tests were structurally unable to pass on the slow tier. Replaced with
retrieval-relevance, grounding, first-person and source-attribution tests.

Then the first rewrite reintroduced the same error: `voice-grounding-invented` asserted refusal wording that
only the fast tier produces, and failed on the first run for exactly that reason. Re-done as an `llm_judge`
assertion that holds on both tiers.

### Full verification

- `tsc --noEmit` clean on both workspaces; production build succeeds.
- Lint: 29 problems / 23 errors, **down** from the 31 / 25 baseline on HEAD — no new lint errors introduced.
- Auth: unauthenticated `/api/voice-token` and `/api/rag-search` both 401; authenticated both 200.
- The three new `cv-ui` proxies verified by direct handler invocation (they never run under plain Vite):
  200 / 200 / 200, GET rejected 405, and a missing secret fails closed with 500 and no upstream call.
- **True end-to-end**: `voice-token` → live Gemini WebSocket → spoken question via macOS `say` →
  `search_portfolio` → real `/api/rag-search` → grounded spoken answer → `voice-trace` returning 200 with
  cost sourced from real `usageMetadata`. The spoken answer carried the real 95% benchmark figure from
  retrieved content, in first person, in spoken register.
- **Real browser walkthrough** (Playwright, fake mic device): chat opens → mic button visible → orb mounts →
  token minted through Vite's proxy → WebSocket connects to Gemini → `setupComplete` → audio capture starts at
  16 kHz → status reaches **Listening** with the 2:00 cap counting down → "End voice" returns to text mode.
  **Zero console errors.** Screenshot: `process/scratch/phase-5b/voice-ui-connected.png`.
- Evals: **55/56 (98%)**, with `voice_quality` 6/6, `factual_accuracy` 9/9 and `multi_turn` 5/5. Every test
  this phase changed passes. Ops snapshot regenerated (`scripts/embed-evals.ts`).
- Two **pre-existing flaky** tests account for the variance across runs — `multi-no-repeat` (LLM judge on
  "don't restate yourself") and `retrieval-pentest-detail` (depends which chunks rank). Both predate Phase 5b:
  `multi-no-repeat` passed 2026-08-18 and failed 08-19. A clean run hit 56/56; the recorded run is 55/56.
- One run degraded to 48/56 purely from **Gemini embedding rate limits** after four back-to-back suites plus
  many Live sessions — `searchPortfolio` returned zero chunks. Verified transient: the same queries returned
  5 chunks each once load stopped. Worth knowing before treating a bad eval run as a regression.

### Deploy checklist — voice will not work correctly without these

1. **Run `scripts/supabase-setup.sql` against the live project.** `voice_rate_limits` does not exist yet, and
   `checkRateLimit` fails *open* — until it's created there is no voice rate limiting at all, silently.
2. **Run `npm run prompt:sync`.** Deliberately NOT done here: Langfuse serves the live prompt and syncing now
   would make the deployed text chatbot start telling visitors voice exists before the voice code ships. Run
   it as part of the deploy, not before.
3. Set `GOOGLE_API_KEY` on the `cv-chat-service` Vercel project if it isn't already (it's the same key RAG
   embeddings use).

### Discovered during Implement: `chatbot-prompt.txt` is not what the chatbot reads

`api/_shared/prompt.js` fetches `chatbot-system` @ label `production` from **Langfuse**, falling back to the
local file only when Langfuse is unconfigured. A prompt was synced in Phase 2 (v1), so editing
`chatbot-prompt.txt` alone changes nothing at runtime. `CLAUDE.md` and the roadmap both recorded the opposite
("prompt:sync — not run yet"); that was wrong and cost a debugging cycle when the updated prompt appeared to
have no effect. Both files are now corrected. To test a prompt change locally without touching production,
start the dev server with `LANGFUSE_SECRET_KEY=` — dotenv won't override an already-set variable, so the
local file is used. That's how the new prompt was verified here.

### Other follow-ups

- `OPENAI_API_KEY` is now unused in `cv-chat-service` and can be removed from the Vercel dashboard.
- The Phase 5b scratch harness (`process/scratch/phase-5b/`) is retained: `_audio.mjs`, `_session.mjs` and the
  ten spoken questions in `05-toolcall-rate.mjs` are the tool-call regression check, and `08-e2e.mjs` is the
  end-to-end. Neither is wired into an npm script yet — same manual-step status as `rag:sync` and `evals`.
