# Phase 4 — Evals + Prompt-Injection Defense

Status: **✅ Done** — Investigate/Plan/Test/Implement all complete, full eval suite run for real against the
live local service: 50/50 non-deferred tests passing. Decision context: three scoping questions answered
inline below. Depends on Phase 2 (chatbot exists) and Phase 3 (chat service's final location/auth model) —
both done.

## 1. Investigation findings

### The eval harness is generic and reusable; the content is 100% Santiago's

`cv-chat-service/evals/` is a real, working eval runner (`runner.ts`) with deterministic assertions
(`assertions.ts`: `contains`, `contains_any`, `not_contains`, `max_words`, `min_words`, `regex`, `rag_used`,
`rag_not_used`, `source_includes`, `source_not_includes`) plus an LLM-judge path (`llm-judge.ts`, Claude Haiku,
already model-generic — no OpenAI). The harness mechanics need no rework. Every dataset file under
`evals/datasets/*.json`, however, asserts facts about Santiago (Sevilla, Jacobo the AI agent, Santifer
iRepair, career-ops, 71 evals, `hi@santifer.io`) and is majority-Spanish. 10 dataset files, **73 test cases**
total (roadmap's "71-case" figure is close enough — was written before an exact recount).

| File | Tests | Verdict |
|---|---|---|
| `factual.json` | 11 | Rewrite — Taher facts from `cv-data.ts`. 2 tests (`canon-global-no-formula`, `canon-multi-offer-weighted-ok`) assert details of "career-ops," a Santiago project with no Taher equivalent — **drop**, don't rewrite. |
| `persona.json` | 4 | Rewrite — structure (first-person, not-servile, professional-tone, confidence) is persona-agnostic, just needs TJ-flavored English phrases. |
| `boundaries.json` | 7 | Rewrite — mostly generic (salary/availability/personal/off-topic/meta-reset/meta-delete). `competitors` test (Apple vs. Samsung, phone-repair framing) doesn't map to Taher — needs a genuinely different question, not a find-replace. |
| `quality.json` | 7 | Rewrite — structural checks (conciseness, no-bullet-lists, metrics-included, tone via LLM judge, response-variation, generic-question-depth) are persona-agnostic; just reword prompts/expected content. |
| `safety.json` | 7 | Rewrite — jailbreak-resistance patterns are generic; swap `Santi/Santiago` → `TJ/Taher` in the `contains_any` fallback checks. Prompt-leak fingerprint tests already reference phrases that **do** match the current `chatbot-prompt.txt` (verified — see below). |
| `multi-turn.json` | 5 | Rewrite — currently 100% Jacobo/Business-OS/SEO conversation flows (Santiago's specific projects). Needs new flows built from Taher's real `EXPERIENCE`/`PROJECTS`/`SKILLS` in `cv-data.ts`. |
| `rag.json` | 16 | **Reduce + rewrite**, not 1:1 port — see "RAG-dependent datasets" below. |
| `source-badges.json` | 5 | **Reduce + rewrite**, not 1:1 port — see "RAG-dependent datasets" below. |
| `languages.json` | 5 | **Delete** — tests ES/EN bilingual behavior; app is English-only (locked decision). |
| `voice.json` | 6 | **Defer to Phase 5** — leave untouched; tests `/api/rag-search` for voice mode, which is dormant and about to change architecture (OpenAI Realtime → Google Live API). |

### RAG-dependent datasets (`rag.json`, `source-badges.json`) test a capability that doesn't exist yet

Both files assert multi-article disambiguation: "does asking about Jacobo return the `jacobo` badge and not
`business-os`," "does the n8n question route to `n8n-for-pms` and not `jacobo`." That capability is driven by
`ARTICLE_KEYWORDS`/`ARTICLE_ROUTES` in `api/_shared/rag.js` — both **intentionally empty objects** today,
because no case-study articles exist yet (Phase 2 bootstrapped RAG from `public/llms.txt` only, a single flat
source, per the already-recorded "Explicitly deferred" item in Phase 1 and 2). There is nothing to disambiguate
between yet, so a faithful port of these 21 tests is impossible — I'm treating this the same way as the
`voice.json` call: **rewrite a smaller set that tests what's real today** (does RAG fire on detail questions,
stay silent on greetings/contact, avoid inventing facts not present in `llms.txt`), and note that full
per-article coverage comes back once real case-study articles exist and `ARTICLE_KEYWORDS`/`ARTICLE_ROUTES`
get populated. Flagging this clearly since it's a bigger scope cut than the three decisions already confirmed
— happy to adjust before Test stage if you want it handled differently.

### The 6-layer defense (from the original README/JSON-LD) is already implemented, active, and mostly generic

`reference/santiago-original/main.tsx:120` documents it as: **keywords, canary, fingerprint, anti-extraction,
online scoring, adversarial**. All six are live in `cv-chat-service` today (Phase 2 carried them over):

1. **Keywords** — `classifyIntent()` in `rag.js:375` — keyword-pattern jailbreak detection (`ignore previous`,
   `pretend`, `dan`, `system prompt`, etc.), bilingual pattern list, tags `jailbreak-attempt`. Generic, no
   changes needed.
2. **Canary** — `chat.js:128` — per-request UUID injected as `internal_ref`, checked against output. Generic.
3. **Fingerprint** — `PROMPT_FINGERPRINTS` in `rag.js:448` — literal phrases from `chatbot-prompt.txt`
   (`MANDATORY BREVITY`, `maximum 150 words per response`, `CRITICAL Instructions`, `Anti-extraction
   (CRITICAL)`, `internal_ref token check`, `cache_control`). **Verified**: 5 of 6 phrases are found verbatim
   in the current TJ prompt; the 6th (`cache_control`) is an API-param name, not prose, so it's not expected
   to appear in the prompt text — it's there to catch leaked implementation jargon, not a broken fingerprint.
   No fix needed, just confirmed in sync (per the existing `CLAUDE.md` note to keep them that way).
4. **Anti-extraction** — prompt-level instructions inside `chatbot-prompt.txt` itself — already TJ-specific
   from Phase 2.
5. **Online scoring** — `scripts/evaluate-traces.ts` — batch LLM-as-judge over recent Langfuse traces. Its
   `EVALUATOR_PROMPT` is 100% Santiago (`Santiago Fernández, an AI Product Manager based in Seville, Spain`,
   his email, his public-info allowlist). **Needs a full rewrite** for Taher's public-info boundary.
6. **Adversarial** — `scripts/adversarial-test.ts` — generates jailbreak attacks with Sonnet, runs them
   against the live chat API, judges resistance with Haiku. Its attack-generation prompt hardcodes
   "Santiago Fernández (AI Product Manager)" and his specific boundary rules. **Needs a rewrite** for TJ.

So Phase 4 isn't building defense from scratch — it's proving the existing generic defense holds for Taher's
content/persona, and fixing the two scripts (5, 6) whose *prompts* still describe Santiago.

### A real bug: three scripts will 401 against the actual (post-Phase-3) chat service

`evals/runner.ts`, `scripts/adversarial-test.ts`, and `scripts/prompt-regression.ts` all default
`CHAT_API_URL` to `http://localhost:3000/api/chat` — the pre-Phase-3 `vercel dev` convention. Since the split,
local dev serves `cv-chat-service` on **`:8787`** (`scripts/dev-server.mjs`), and — more importantly —
**none of these three scripts send an `Authorization: Bearer $CHAT_SERVICE_SECRET` header**, which
`cv-chat-service/api/chat.js` has required since Phase 3. Pointed at the real service (local or deployed),
all three currently get a 401 before any eval logic even runs. This is a genuine regression these dormant
scripts never got updated for during the Phase 3 split — not a judgment call, just a fix: update the default
port and add the auth header to all three.

### `tests/ops-contract.test.ts` / `tests/ops-dashboard.test.ts` are Phase 5, not Phase 4

Confirmed by reading both: they validate `/api/ops/*` endpoints (auth, stats, traces, trace detail, evals,
prompts, rag-stats) — the dormant `/ops` LLMOps dashboard, not the chatbot or its defenses. The roadmap's
Phase 4 scaffolding list included them by loose association; reclassifying to Phase 5 below.

### No OpenAI references left to remove in scope

Searched `scripts/`, `evals/`, `tests/`, `api/` for `openai`/`OpenAI`/`gpt-`. Hits: a code comment in
`ingest-rag.ts` (explaining a batching choice, references OpenAI historically, not a dependency), a SQL
comment in `supabase-setup.sql` (documents the old `vector(1536)` dimension choice, historical context, still
accurate), one assertion value in `rag.json` (`"GPT-4.1 mini"` — inside the dataset being rewritten anyway),
and `api/voice-trace.js`/`voice-token.js` — real OpenAI Realtime API usage, but that's the Phase 5 voice-mode
swap-to-Google-Live-API item, out of scope here. Nothing else to clean up.

## 2. Decisions

Confirmed via three scoping questions before writing this plan:

- **Ops test files** → reclassify to Phase 5's scaffolding list in the roadmap; leave both files untouched now.
- **`languages.json` + the `language`/`assertLanguage` assertion type** → delete both. No bilingual behavior
  left to test; also drop the now-pointless `lang: 'es'|'en'` field from the dataset schema and `Test`
  interface in `runner.ts` (every remaining test would carry a dead, always-`'en'` field otherwise).
- **`voice.json`** → defer to Phase 5 untouched, per the reasoning above.
- **`rag.json`/`source-badges.json` scope cut** → my own call, flagged above, applying the same "don't test
  infrastructure that doesn't exist yet" logic as the voice.json decision. Open to a different call here.

## 3. Planned scope for Test/Implement stages

**Scripts** (`cv-chat-service/scripts/`, `evals/runner.ts`):
- Fix `CHAT_API_URL` default (`:3000` → `:8787`) and add `Authorization: Bearer $CHAT_SERVICE_SECRET` header
  in `runner.ts`, `adversarial-test.ts`, `prompt-regression.ts`.
- Rewrite `evaluate-traces.ts`'s `EVALUATOR_PROMPT` public-info block for Taher (name, location, email,
  content-sensitivity boundary — same Apple/SAP-BTP-nameable-but-generalized rule as everywhere else).
- Rewrite `adversarial-test.ts`'s attack-generation prompt persona description for TJ; drop the
  `multilingual_bypass` attack category's Spanish-mixing assumption down to what's still meaningful
  single-language (the category itself — testing non-English-input bypass attempts — still makes sense to
  keep, since the bot should stay in English/on-persona even if probed in Spanish).
- `chats.ts`/`chats-tui.ts` — pure Langfuse trace viewers, no persona content, no `CHAT_API_URL` calls. No
  changes needed; confirmed reusable as-is.

**Datasets** (`evals/datasets/`): rewrite `factual.json` (minus the 2 career-ops tests), `persona.json`,
`boundaries.json` (with a new `competitors`-equivalent question), `quality.json`, `safety.json`,
`multi-turn.json` (new flows from real `cv-data.ts` content) in English, asserting Taher/TJ facts. Rewrite a
reduced `rag.json` + `source-badges.json` scoped to single-source (`llms.txt`) retrieval quality. Delete
`languages.json`. Leave `voice.json` untouched/deferred.

**Harness** (`assertions.ts`, `runner.ts`): remove `assertLanguage`/`'language'` assertion type and the `lang`
field from the `Test`/dataset schema.

**Docs**: rewrite `evals/README.md` in English (currently Spanish, describes "Santi", references `vercel dev`
and stale category counts). Update `roadmap.md` (Phase 4 status, move ops-test files to Phase 5's list) and
`CLAUDE.md` per the "update both each phase" rule.

**Re-adding to CI/build**: roadmap says "re-add the evals step to CI/build once the dataset is real" — there
is no CI pipeline in this repo yet (deploys are Vercel's own git-push-triggered builds, no GitHub Actions).
Treating "re-add to CI" as out of scope until a CI pipeline exists at all; `npm run evals` stays a manually-run
step like `rag:sync`, consistent with the Phase 3 precedent of not restoring pipeline automation until a
concrete need exists.

## 4. Test stage ✅ Done

Validated against the real running `dev-server.mjs` + live chat pipeline (Anthropic/Gemini/Supabase, not
mocked), scratch work in `process/scratch/phase-4/` (gitignored, not committed):

- **Auth-header fix confirmed.** Curled `/api/chat` with no `Authorization` header → `401`, exactly as
  predicted. Added `Authorization: Bearer $CHAT_SERVICE_SECRET` → `200`. This is the fix to carry into
  `runner.ts`, `adversarial-test.ts`, `prompt-regression.ts` in Implement.
- **Harness mechanics survive the Phase 3 move.** Wrote a throwaway 3-case TJ-specific dataset
  (`mini-persona.json`) plus a scratch runner (`test-runner.ts`) that reuses the *real*
  `evals/assertions.ts` module (not reimplemented) with the auth fix applied and pointed at `:8787`. All 3
  passed against real responses — first-person phrasing, correct Apple/SAP BTP mention, and a RAG-triggered
  detail question all worked as expected. SSE parsing and the `rag-sources` event parsing both still work
  unchanged.
- **The reduced `rag.json`/`source-badges.json` approach is validated, not just assumed.** Every real
  `ragSources` response returned `article_id: "home"` — confirming there's currently exactly one possible
  article ID, so `source_includes`/`source_not_includes` assertions against named case studies (`jacobo`,
  `business-os`, etc.) would be meaningless today; only `rag_used`/`rag_not_used` carry signal. Ran a 3-case
  `rag-probe.json`: greeting correctly skipped RAG, a contact question answered from the prompt directly
  without RAG, and — the most useful check — a "give me an exact dollar figure" question that pushes toward
  hallucination got a real, honest "I don't have that figure" instead of an invented number. Confirms the
  no-hallucination assertion style produces genuine signal, not a rubber stamp.
- **New finding: `llm-judge.ts`'s own judge prompt is hardcoded in Spanish**, independent of whatever
  criteria/response text it's given — probed it directly (`judge-probe.ts`) and got back a real, correctly-
  parsed JSON verdict, but with the `reason` field in Spanish. The judge mechanism itself works fine (valid
  JSON, sensible verdict — correctly flagged an overly self-promotional tone in the probe text), but the
  prompt template needs translating to English too, for the same English-only consistency reason as
  everything else in this phase. Adding to Implement scope below.

## 5. Implementation ✅ Done

Everything in Section 3's scope was implemented as planned:

- Fixed the auth/port bug in `runner.ts`, `adversarial-test.ts`, `prompt-regression.ts` (localhost:3000 →
  :8787, added `Authorization: Bearer $CHAT_SERVICE_SECRET`); removed the dead `lang` field and `language`
  assertion type everywhere (harness, `Assertion`/`Test` interfaces, `evaluate-traces.ts`'s auto-gen path).
- Rewrote `evaluate-traces.ts`'s `EVALUATOR_PROMPT` for Taher's public/private info boundary (Apple/SAP BTP
  nameable, internal tool names/tickets not); also fixed a stale judge model id (`claude-sonnet-4-5-20250929`,
  found nowhere else in the codebase) to `claude-haiku-4-5-20251001`, matching every other judge/scoring call
  site.
- Rewrote `adversarial-test.ts`'s attack-generation persona description for TJ.
- Translated `llm-judge.ts`'s judge prompt template to English (the Test-stage finding).
- Rewrote all in-scope datasets in English with Taher's real facts (`cv-data.ts`/`chatbot-prompt.txt`/
  `llms.txt`): `factual.json` (9, down from 11 — dropped the 2 career-ops tests with no Taher equivalent),
  `persona.json` (4), `boundaries.json` (7, with a new `competitor-opinion` test replacing the Apple-vs-Samsung
  phone-repair one), `quality.json` (7), `safety.json` (7), `multi-turn.json` (5, built from real
  experience/projects). Reduced and rewrote `rag.json` (16 → 8) and `source-badges.json` (5 → 3) to test
  single-source (`llms.txt`, `article_id: "home"`) retrieval quality instead of multi-article disambiguation,
  per the plan. Deleted `languages.json`. Left `voice.json` untouched, deferred to Phase 5.
- Rewrote `evals/README.md` and `evals/.env.example` in English, with the corrected dev workflow (`:8787`,
  `CHAT_SERVICE_SECRET` required) and an explicit note that `voice.json` is expected to fail/error locally
  until Phase 5.

### Full-suite run: 50/56 (89%) — all 50 non-deferred tests pass

Ran `npm run evals` for real against the local `dev-server.mjs` adapter (not a dry run). First pass: 47/56,
with 3 real failures in `response_quality` and the 6 expected `voice_quality` errors (`/api/rag-search` isn't
routed in the local dev adapter — pre-existing, unrelated to this phase's changes, matches the README's
documented caveat).

The 3 `response_quality` failures were all **test-authoring bugs surfaced by dogfooding the suite against the
real bot**, not chatbot defects — read the actual failing responses in the generated report before concluding
that:

- `tone-quality`: the judge criteria penalized citing concrete metrics (95%, 68x) as "self-promotional," but
  citing metrics is `chatbot-prompt.txt`'s explicit house style ("let the numbers speak"). The actual response
  was good. Fixed by clarifying the criteria: metrics are expected and fine, only hype adjectives
  ("brilliant," "impressive") or corporate-speak should fail it.
- `response-variation`: the judge treated same-topic-with-new-specifics as "not different enough," but the bot
  has a fixed, limited set of real facts to draw from — it can't invent new topics on repeat, only new angles
  on the same ones (which it did: added LangGraph/query-rewriting detail not in the first answer). Loosened
  the criteria to accept new concrete specifics on the same underlying projects.
- `generic-question-depth`: a brittle `contains_any` list of exact redirect phrases, when the prompt
  explicitly instructs varied, non-formulaic phrasing. The bot's actual redirect ("What aspect of my work are
  you curious about?") was fine, just didn't match the literal string list. Replaced with an `llm_judge`
  assertion checking for the presence of an invitation to go deeper, not specific wording.

Re-ran after the fixes: **50/50 non-deferred tests pass**, `voice_quality` still 0/6 as expected/documented.
Final report: `cv-chat-service/evals/results/report-2026-08-18.md` (gitignored).
