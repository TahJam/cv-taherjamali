# Roadmap — cv-taherjamali

**What this is:** a fork of santifer.io (Santiago Fernández's AI-powered portfolio) being turned into my own digital CV — same architectural pattern (a site that demonstrates engineering skill instead of
just listing it: real content, an AI chatbot backed by real observability), entirely new content, identity, and
persona. Built incrementally, phase by phase, rather than all at once.

This file is the high-level map. Once a phase is actively being worked, it gets its own detailed plan at
`docs/plans/phase-N-<name>.md`, linked from that phase's section below. This file stays high-level — status,
scope, and what depends on what — not implementation detail.

## Locked decisions

These apply across all phases; don't relitigate them without a reason:

- **Language:** English only. No ES/EN branching, dual slugs, or `i18n.ts`-style translation file — removed
  deliberately in Phase 1, not an oversight.
- **Content sensitivity:** My current role involves platform security/AI work at Apple.
  All public-facing content (site copy, and later chatbot/RAG content) generalizes internal system/tool names,
  ticket numbers — describe work through publicly available tools such as SAP BTP, Cloud Foundry, etc. Don't mention Apple internal tools by name,
  instead briefly describe what the tool does in general terms. `src/cv-data.ts` shows the pattern in practice.
- **Workflow:** working directly on `main` in this repo, no feature branches — this is my own clone, not
  upstream. `upstream` remote (`santifer/cv-santiago`) stays wired for reference/credit; `origin`
  (`TahJam/cv-taherjamali`) is where work actually pushes.
- **Dormant subsystems are a head start, not a blocker:** the original chatbot/RAG, evals, prompt-injection
  defense, and `/ops` dashboard code all still exists in the repo (see "Existing scaffolding" per phase below) —
  real, working code, just built for Santiago's content and disconnected from the live app. Each phase adapts
  the relevant subsystem rather than rebuilding from zero. Don't assume a dormant subsystem works until it's
  actually wired into `src/main.tsx` — check there before trusting a feature is live.
- Also note, when working on a phase, make sure to check the existing scaffolding in the repo to see if it can be adapted rather than rebuilding from zero. If adapting existing scaffolding (files) is not possible
  (too much work, or too different), then rebuild from zero but keep the original file as a reference in the `reference` folder.
- With each phase, make sure to update this roadmap file and the README file to reflect the current status.
- **Service architecture (locked 2026-08-06):** the app splits into two physically separate services — UI
  (static site + chat widget frontend) and a Chat/AI service (`api/chat.js`, `rag.js`, `prompt.js` today;
  voice + `/ops` API once those phases land, since both are the same AI-service concern with the same
  secrets). No third "backend" service — nothing in this app has backend responsibilities outside those two
  buckets. Deployed as two separate Vercel Projects from the same monorepo (different Root Directory per
  project), not two repos. Vercel has no private networking between projects — cross-service calls go over
  public HTTPS, protected by an application-level shared secret the UI's server-side sends and the chat
  service verifies, not a network-level boundary. See `docs/adr/002-chat-service-isolation.md` for the full
  reasoning and rejected alternatives.

## Phase status

| Phase | Name | Status |
|---|---|---|
| 1 | Foundation & Branding | ✅ Done |
| 2 | Text Chatbot + RAG | ✅ Done |
| 3 | Service Split — Isolate the Chat/AI Backend | ✅ Done |
| 4 | Evals + Prompt-Injection Defense | Not started |
| 5 | Voice Mode + `/ops` LLMOps Dashboard | Not started |

---

## Phase 1 — Foundation & Branding ✅ Done

**Goal:** a single-language English homepage with my real content, no AI infra — get the identity/content
layer right before touching anything AI-related.

**Scope:**
- Rewrite the homepage (`src/App.tsx`, new `src/cv-data.ts` as single source of truth) with my real
  profile, experience, projects, education, skills — employer detail generalized per the content-sensitivity
  rule above.
- Strip the ES/EN bilingual architecture entirely (`GlobalNav.tsx`, `main.tsx`, removed `AboutPage.tsx`/
  `PrivacyPolicy.tsx`, dropped hreflang/dual-slug logic).
- Empty `src/articles/registry.ts` of Santiago's 9 case studies, keeping the type shape/helpers intact for
  my future case studies.
- Stop rendering the floating chatbot widget (persona/content was Santiago's — Phase 2 work) while leaving the
  underlying files in place for reuse.
- Rewrite `index.html` meta/JSON-LD, trim `package.json`'s build script (was a 15-step pipeline tied to
  Santiago's accounts — RAG sync, prompt sync, social-stat scraping, prerendering, IndexNow), clean up
  `vercel.json`'s dead redirects and the false `X-Evals: 71` header.
- Dead-code sweep: removed 11 unrouted Santiago-specific article components + their i18n data files, 2 more
  dead files found by tracing the real import graph (`MusicToggle.tsx`, `tech-icons.ts`), 9 orphaned `public/`
  asset folders, unused `vendor/`/`audio/` assets, and 14 orphaned root images — 357 files, ~22.7k lines.
  Verified every deletion by tracing actual imports (including cross-checking against the dormant chatbot
  subsystem so nothing it depends on got orphaned), not just filename pattern-matching.
- Rewrote crawler-facing identity files (`robots.txt`, `llms.txt`, `humans.txt`, `.well-known/security.txt`) —
  these were still 100% Santiago's identity and being served live to real crawlers. Rewritten from
  `cv-data.ts` facts only, with no claims about subsystems (chatbot, evals, prerendering) that aren't live yet.
- Updated `CLAUDE.md` to describe the repo as it actually is now, not as the original chatbot/RAG/evals demo.

**Explicitly deferred to later (not blockers, just not done):**
- Real headshot photo — hero still uses a monogram placeholder (`App.tsx`); I have headshots ready, wiring
  them in was deferred to a UI polish pass.
- Visual/UI redesign — still running on Santiago's dark/orange skeleton; colors/layout polish deferred until
  content and features are further along.
- No domain yet (targeting a `*.vercel.app` URL for now) — flagged as a future blocker for canonical URLs,
  sitemap, and the `Sitemap:`/`Canonical:` fields left as `TODO` in `robots.txt`/`security.txt`.
- Minor content leak in kept generic article infra (`src/articles/components.tsx`, `content-types.tsx`) —
  a couple of hardcoded Santiago-specific default prop values (e.g. an avatar path, a screenshot base path).
  Harmless; worth genericizing whenever my first real case study gets built.

---

## Phase 2 — Text Chatbot + RAG ✅ Done

**Goal:** a working text chatbot on the site, backed by RAG over my real content, with a rewritten
persona — the interactive/agentic layer that makes this a "digital CV" rather than a static resume.

Full investigate/plan/test/implement writeup: **[`docs/plans/phase-2-chatbot-rag.md`](phase-2-chatbot-rag.md)**.

**Scope:**
- Rewrote `chatbot-prompt.txt` as **TJ**, a distinct first-person persona — English, generalized per the
  content-sensitivity rule (Apple/SAP BTP/Cloud Foundry nameable, internal tool names/tickets not), kept
  Santiago's solid generic prompt-engineering patterns (brevity rules, anti-extraction, boundary handling,
  off-topic redirects) while swapping all content.
- Swapped embeddings from OpenAI (`text-embedding-3-small`) to Gemini (`gemini-embedding-2`, truncated to 768
  dims via Matryoshka) — validated model choice, Supabase schema, and end-to-end retrieval with real scratch
  scripts before touching production code (see the plan doc's Test-stage section). Removed the `openai`
  package dependency entirely — nothing in the live app needs it anymore.
- RAG content source: bootstrapped from `public/llms.txt` (found and fixed a real chunking bug in the
  process — the plaintext parser built for this file produced junk bare-header chunks; the markdown parser,
  previously unused, handles it correctly). No case-study articles exist yet, so `ARTICLE_KEYWORDS`/
  `ARTICLE_ROUTES` in `rag.js` are intentionally empty for now — will populate as real articles get written.
- Stripped `FloatingChat.tsx`'s voice-mode and bilingual (`i18n.ts`) coupling — both were threaded through
  ~15 places each. Deleted `src/i18n.ts` entirely once nothing referenced it. Simplified
  `src/articles/registry.ts`'s `ArticleConfig` type from `{es, en}` slug/title pairs to single-path English.
- Re-rendered the chat widget in `src/main.tsx`, hidden on `/ops` like the nav.
- Set up new Supabase, Langfuse, Resend, and Google AI accounts; re-added `rag:sync` to `npm run build`
  (degrades gracefully if env vars are missing, so it won't break a deploy that hasn't set them up).
- Caught a real bug in Test-stage validation before it shipped: the draft prompt hallucinated a plausible
  but fake contact email when tested standalone, because the real email was injected dynamically per-request
  (a bilingual-era leftover). Fixed by baking the real email directly into the static prompt instead.
- Verified the full pipeline end-to-end by invoking `api/chat.js`'s exported handler directly with a real
  `Request` object (no Vercel CLI installed locally, so no `vercel dev`) — confirmed RAG retrieval, streaming,
  and Langfuse's graceful fallback all work against the real Supabase index.

**Explicitly deferred to later (not blockers, just not done):**
- Real case-study articles — RAG runs on `llms.txt` only for now; richer, section-anchored content comes as
  articles get written.
- Chat avatar image — still a placeholder (`TJ` monogram), same unresolved headshot decision as the hero.
- Prompt sync to Langfuse (`npm run prompt:sync`) — not run yet; the chat pipeline correctly falls back to
  the local `chatbot-prompt.txt` file when nothing's synced, so this isn't blocking, just not done.

**Depends on:** Phase 1 content being stable (RAG needs real source material to index).

---

## Phase 3 — Service Split: Isolate the Chat/AI Backend ✅ Done

**Goal:** move the chat/RAG pipeline out of the UI's Vercel project into its own physically separate service —
own deploy, own domain, own secrets — reachable only via a shared-secret-authenticated call from the UI's
server-side. See `docs/adr/002-chat-service-isolation.md` for why (two services not three, physical not just
logical separation, no private networking available on Vercel so auth is application-level).

Full investigate/plan/test/implement writeup: **[`docs/plans/phase-3-service-split.md`](phase-3-service-split.md)**.

**Scope:**
- Restructured into an npm workspaces monorepo: `cv-ui/` (everything UI — `src/`, `public/`, its own thin
  `api/chat.js` proxy) and `cv-chat-service/` (`api/chat.js` real handler, `rag.js`, `prompt.js`,
  `chatbot-prompt.txt`, plus all Phase 4/5 dormant subsystems moved wholesale — `api/ops/*`, voice API,
  `evals/`, `tests/ops-*` — since they're the same AI-service concern). Root is orchestration + shared docs
  only, zero app code.
- Shared-secret auth (`CHAT_SERVICE_SECRET`) — `cv-chat-service/api/chat.js` rejects anything without a
  matching header before doing any real work. `CHAT_SERVICE_URL` is always an env var, never hardcoded — dev
  vs. prod is purely a difference in that value.
- Test-stage validated the two real risks before implementing: (1) whether a fetch-and-passthrough proxy
  actually streams live or gets buffered — built a real two-process test, confirmed it streams correctly, and
  found the fix (`X-Content-Type-Options: nosniff`) for a documented Vercel production-buffering gotcha along
  the way; (2) npm workspaces + `concurrently` actually work as intended — built and ran a real throwaway
  skeleton to confirm before touching the real repo.
- Local dev: `cv-chat-service/scripts/dev-server.mjs` (a small Node HTTP server wrapping the real Fetch-API
  handler, `Readable.fromWeb()` bridge for streaming) plus `cv-ui/vite.config.ts`'s dev-only proxy — which
  also injects the shared secret itself, since it's standing in for the proxy function that never actually
  runs under plain Vite.
- Found and fixed a real coupling issue during implementation: `export-chunks.ts`/`ingest-rag.ts` needed
  `cv-ui/src/articles/registry.ts` and `cv-ui/public/llms.txt` — fixed via an intentional, documented, one-way,
  dev-time-only cross-workspace read (these scripts aren't part of the deployed runtime).
- `rag:sync` came out of the automatic build pipeline entirely as a consequence of the split — it doesn't
  belong in either service's deploy anymore, it's now a manually-run content-ingestion step.
- Swept 4 more dead Santiago-specific scripts found broken by the move (`update-discord-stats.ts` and 3
  siblings — referenced the `i18n.ts` deleted in Phase 2, never wired into any npm script).
- Verified end-to-end for real: curled the chat-service adapter directly (auth rejection + real streamed
  response), then a full browser test through Vite's dev server → proxy → adapter → real Anthropic/RAG
  pipeline, with a screenshot confirming the rendered response.

**Explicitly deferred to later (not blockers, just not done):**
- Actual Vercel deployment of both projects — everything above is validated locally; the second Vercel
  Project, dashboard env vars, and Root Directory settings still need to be set up manually (only you can do
  this — needs your Vercel account).
- Vercel's monorepo workspace-root install behavior — documented as supported, but only a real deploy
  actually proves it for this repo.

**Depends on:** Phase 2 (nothing to split until the chat service exists and works).

---

## Phase 4 — Evals + Prompt-Injection Defense

**Goal:** the quality/safety layer that backs up the chatbot — automated eval suite + the 6-layer
prompt-injection defense described in the original README, both currently asserting facts about Santiago.

**Existing scaffolding (dormant):** `evals/` (71-case suite, deterministic + LLM-as-judge),
`tests/ops-contract.test.ts`, `tests/ops-dashboard.test.ts`. The injection-defense layers live inside
`api/chat.js`/`api/_shared/rag.js` and are already active (Phase 2) — this phase is really about building the
eval dataset that proves the chatbot works correctly for my content, now against wherever Phase 3 relocated it.

**Rough scope (detail goes in `phase-4-evals-defense.md` when this starts):**
- New eval dataset asserting facts about me, not Santiago.
- Verify/tune the 6-layer injection defense against my persona and content.
- Re-add the evals step to CI/build once the dataset is real.
- Update the evals to use Google Gemini models and remove OpenAI models.

**Depends on:** Phase 2 (nothing to eval or defend until the chatbot exists) and Phase 3 (evals should target
the chat service's final location, not get built against a layout that's about to move).

---

## Phase 5 — Voice Mode + `/ops` LLMOps Dashboard

**Goal:** voice interaction with the chatbot, and a password-protected `/ops` dashboard for observing it in
production (conversations, costs, RAG, security, evals, voice, prompts, system health).

**Existing scaffolding (dormant):** `src/useVoiceMode.ts`, `src/VoiceOrb.tsx`, `src/useAudioAnalyser.ts`,
`src/ops/`, `api/ops/`. The dashboard reads from Langfuse + Supabase — both accounts already exist (set up in
Phase 2 for RAG) — but the dashboard itself is still unwired; currently routed at `/ops` but unlinked from the
UI and non functional. Per the service-architecture decision, both land in the Chat/AI service (Phase 3), not
the UI.

**Rough scope (detail goes in `phase-5-voice-ops.md` when this starts):**
- Wire voice mode into `FloatingChat.tsx`.
- Point `/ops` at real data; decide on its auth/password setup.
- Update the ops dashboard to use Google Gemini models and remove OpenAI models.
  - Swap out OpenAI's Realtime API with Google's equivalent, Live API. (this might be a large diff so consider splitting into smaller PRs)

**Depends on:** Phase 2 (voice needs a working text chatbot underneath it), Phase 3 (this is where the service
that hosts voice/ops actually lives), and Phase 4 (dashboard's `Evals`/`Security` tabs need the eval suite and
defense layers to be real).
