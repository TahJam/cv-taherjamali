# Phase 2 — Text Chatbot + RAG

Status: **Investigate/Plan stage** (per `CLAUDE.md`'s four-stage workflow) — not yet tested or implemented.
This doc is the output of the Investigate + Plan stages. Test (scratch scripts in `process/scratch/`) and
Implement come after the open decisions below are resolved.

## 1. Investigation findings

Read in full: `api/chat.js` (669 lines), `api/_shared/rag.js` (472 lines), `api/_shared/prompt.js` (13 lines),
`chatbot-prompt.txt` (205 lines), `src/FloatingChat.tsx` (1058 lines), `scripts/export-chunks.ts`,
`scripts/ingest-rag.ts`, `scripts/supabase-setup.sql`. Skimmed `src/i18n.ts` and `src/main.tsx`.

### What's directly reusable, close to as-is

- **`api/chat.js`** — the streaming pipeline (Anthropic SDK, SSE, agentic tool-use for RAG, leak detection,
  graceful degradation/retry, cost tracking, Langfuse tracing) is generic engineering, not Santiago-specific.
  Needs only: hardcoded `hi@santifer.io` → Taher's email (3 spots: `langInstruction`, two error-message
  strings), and the Spanish half of every bilingual branch removed (site is English-only — Phase 1 already
  established this; `chat.js` just never got the memo).
- **`api/_shared/prompt.js`** — Langfuse prompt registry + file fallback. Zero Santiago-specific content, works
  as-is once `chatbot-prompt.txt` is rewritten.
- **RAG orchestration logic in `rag.js`** (`searchPortfolio`, `rerankChunks`, `diversifyByArticle`,
  `classifyIntent`, leak/fingerprint detection plumbing) — generic, reusable as-is.
- **`FloatingChat.tsx`'s core chat UI** — streaming word-drain animation, markdown rendering, sessionStorage
  persistence, quick-prompt buttons, contact CTA, mobile layout — all generic and reusable.
- **`scripts/export-chunks.ts`'s Parser 2 (plaintext)** — already built to chunk a file like `llms.txt` by
  `##` headers. Directly relevant given the content-source gap below.
- **Supabase schema** (`scripts/supabase-setup.sql`) — hybrid search function (pgvector + BM25) is
  provider-agnostic; only the `vector(1536)` column width is tied to OpenAI's embedding size (see #2, embedding
  model decision).

### What needs real rework, not a find-replace

- **`chatbot-prompt.txt`** — 100% Santiago: Spanish, first-person as "santifer," his projects, his career-ops
  scoring rules (the recent `f335579`/`13a0983` commits in git log were Santiago tuning *this exact file* —
  unrelated to this fork). Needs a full rewrite: English, Taher's persona/facts/projects, new
  `PROMPT_FINGERPRINTS` constants in `rag.js` (the leak-detector matches literal phrases from the *current*
  prompt — e.g. `'BREVEDAD OBLIGATORIA'` — so it goes blind against a new prompt unless those constants are
  updated to match whatever unique internal phrasing the new prompt uses). Also struck: the "Modo voz" section
  (voice is Phase 4, not this phase) and the sevillano-accent voice detail.
- **`FloatingChat.tsx` is more tangled than it looks** — it imports `useVoiceMode`/`VoiceOrb` and branches its
  entire UI on `mode: 'text' | 'voice'` (mic button, voice status text, escape-key handler, orb rendering,
  voice-mode input controls — roughly 15 distinct spots). It also takes a `lang: 'es' | 'en'` prop and pulls
  every UI string from `src/i18n.ts` (`translations[lang].chat`), which is the same bilingual file Phase 1
  intentionally left dead. Wiring this back in for a **text-only** Phase 2 means stripping the voice branches
  (not deleting the file — voice comes back in Phase 4) and replacing the `i18n.ts` dependency with a small
  local English strings object.
- **`src/i18n.ts` becomes fully dead once that happens** — I checked: nothing except `FloatingChat.tsx`
  imports it (not even the other dormant chatbot files). The actual English `chat` strings needed are ~50
  lines (`title`, `subtitle`, `greeting`, `placeholder`, `error`, `offline`, 4 `prompts`, `contactCtaTitle`,
  plus `email` from the lang root) — small enough to inline directly rather than keep a translation layer for
  a single-language site. Worth deleting `i18n.ts` in this phase rather than carrying it further.
- **`main.tsx` has zero chat references** — Phase 1 fully removed it (not commented out), so re-enabling means
  adding the import + render back, not uncommenting.
- **`ARTICLE_KEYWORDS`/`ARTICLE_ROUTES`/`HOME_SOURCE` in `rag.js`** — hardcoded to Santiago's 6 case studies
  with `es`/`en` slug pairs. `src/articles/registry.ts`'s `ArticleConfig` type still requires `slugs: {es, en}`
  too — a Phase 1 leftover inconsistency (bilingual was supposed to be fully gone). Both need to shrink to a
  single English path per article, and `HOME_SOURCE` needs to drop its `/en` fallback.
- **Embeddings are OpenAI** (`text-embedding-3-small`, 1536-dim) — the one actual model dependency in the RAG
  path (chat/rerank were already Claude). Per your roadmap note, this needs to become Gemini — which specific
  model is still open, resolved in the Test stage (#4). This is a real integration change, not a config flag:
  new embed function in `rag.js` (`embedQuery` currently `fetch`s OpenAI's REST endpoint directly — same
  pattern works for Gemini's endpoint), new embedding call in `scripts/ingest-rag.ts`, and a Supabase
  column-width change to match whichever model's output dimension wins.
- **`isRagEnabled()`** gates on `OPENAI_API_KEY && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY` — needs to check
  whatever the new embedding provider's key is instead.

### The gap nothing in the roadmap flagged: RAG has no content to search

`export-chunks.ts` only pulls from `articleRegistry` entries with `ragReady: true` — and `registry.ts` is
currently an **empty array** (Phase 1 emptied it deliberately, no case studies written yet). Wire RAG up today
and `search_portfolio` returns nothing every time. Resolved in #2 (RAG content source decision) via the
`llms.txt` plaintext parser.

## 2. Decisions (resolved 2026-08-06)

- **RAG content source: (c) both, staged.** Ship with `public/llms.txt` bootstrapped via
  `export-chunks.ts`'s existing plaintext parser now, layer in real case-study articles (registry/i18n
  pattern) as they get written later. `ragReady` per-article opt-in already supports mixing both source types.
- **Embedding model: undecided, resolve in Test stage.** Validate `text-embedding-004` (768-dim, stable,
  generous free tier) against `gemini-embedding-001` (configurable output dim up to 3072, Matryoshka
  truncation, tighter free-tier limits) with a real scratch script — actual latency/dimension/rate-limit
  numbers before committing to a Supabase schema, not a guess.
- **Bot persona: named "TJ."** Distinct persona identity (mirrors Santiago's "Santi" pattern), first person,
  own avatar/`aria-label`s ("Chat with TJ" etc.), own greeting/voice in `chatbot-prompt.txt`.
- **Chat avatar image: follow the hero's resolution.** `FloatingChat.tsx`'s two `/foto-avatar-sm.webp`
  references become whatever the hero ends up using (still an open Phase 1 deferral — monogram placeholder
  today). Not re-litigated here; just inherits that decision whenever it lands.
- **External accounts: set up all three now** — Supabase (required for RAG), Langfuse (tracing), and Resend
  (jailbreak email alerts), rather than deferring Langfuse/Resend to Phase 3. These are accounts only you can
  create (email/OAuth signup, API key generation) — see the checklist in #3.

## 3. Account setup checklist (yours to do — I can't create accounts on your behalf)

Needed before the Test stage can validate against real services:

- [ ] **Supabase** — new project, note the project URL + `service_role` key (`SUPABASE_URL`,
      `SUPABASE_SERVICE_ROLE_KEY`). Don't run `supabase-setup.sql` yet — the `vector(1536)` column width in
      it is still tied to OpenAI's dimension; it gets adjusted once the embedding model (Test stage) is
      picked, then run once, correctly, rather than migrated twice.
- [ ] **Langfuse** — new project, note public + secret keys (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`).
- [ ] **Resend** — account + API key (`RESEND_API_KEY`), plus decide what inbox `ALERT_EMAIL` should point to
      for jailbreak alerts.
- [ ] **Google AI (Gemini) API key** — needed for the Test stage's embedding-model comparison regardless of
      which model wins.

Drop these in `.env.local` (already gitignored) once created — I'll pick them up from there for the Test stage
scripts and the eventual `api/chat.js` wiring.

## 4. Test stage (before implementing — scratch scripts in `process/scratch/`)

- Standalone script comparing `text-embedding-004` vs `gemini-embedding-001` against the same sample text —
  real output dimension, latency, and free-tier rate limits for each, so the Supabase schema is set once,
  correctly. This determines the `documents.embedding` column width before `supabase-setup.sql` is run for
  real.
- Standalone script running the Supabase `hybrid_search` RPC against a handful of manually-inserted rows
  (using the chosen embedding dimension) — confirm the schema works end-to-end before wiring it into `rag.js`.
- Manually run the draft `chatbot-prompt.txt` (TJ persona) through a handful of representative questions via
  a bare Anthropic SDK script (no edge function) — sanity-check tone/length/factual grounding, and confirm the
  updated `PROMPT_FINGERPRINTS` actually catch leaks of the new prompt's real internal phrasing.
- Run `export-chunks.ts`'s plaintext parser against `public/llms.txt` and inspect the resulting chunks —
  confirm they're coherent and correctly section-tagged before they're the first thing `search_portfolio`
  ever returns.

## 5. Implementation steps (after Test stage confirms the approach)

1. Rewrite `chatbot-prompt.txt` for Taher as **TJ** (English, generalized per the content-sensitivity rule —
   Apple/SAP BTP/Cloud Foundry nameable, internal tool names/tickets not; own greeting/voice, no leftover
   Santiago career-ops canon rules). Update `PROMPT_FINGERPRINTS` in `rag.js` to match the new prompt's actual
   internal phrasing (validated in Test stage).
2. Strip bilingual + voice branches from `FloatingChat.tsx`; delete `src/i18n.ts`; update TJ's avatar/
   `aria-label`s; re-add the chat widget to `src/main.tsx`.
3. Simplify `ARTICLE_KEYWORDS`/`ARTICLE_ROUTES`/`HOME_SOURCE` (rag.js) and `ArticleConfig.slugs` (registry.ts)
   to single-path English.
4. Swap the embedding provider (rag.js `embedQuery`, `ingest-rag.ts`) to the Test-stage-validated model;
   run `supabase-setup.sql` with the correct column width for real.
5. Update `isRagEnabled()` gate (now checks the Gemini key, not `OPENAI_API_KEY`) and the `MODEL_COSTS`/
   cost-breakdown keys in `chat.js`/`rag.js` to reference the new embedding model's name and pricing.
6. Run `export-chunks.ts` + `ingest-rag.ts` against `public/llms.txt` to seed the RAG index for real.
7. Re-add `rag:sync` to the build pipeline (currently stripped per `CLAUDE.md`'s Commands section).
8. Update `CLAUDE.md`'s "Dormant subsystems" section and `docs/plans/roadmap.md`'s Phase 2 status once this
   ships — per your own added roadmap reminder.
