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

## Phase status

| Phase | Name | Status |
|---|---|---|
| 1 | Foundation & Branding | ✅ Done |
| 2 | Text Chatbot + RAG | Not started |
| 3 | Evals + Prompt-Injection Defense | Not started |
| 4 | Voice Mode + `/ops` LLMOps Dashboard | Not started |

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

## Phase 2 — Text Chatbot + RAG

**Goal:** a working text chatbot on the site, backed by RAG over my real content, with a rewritten
persona — the interactive/agentic layer that makes this a "digital CV" rather than a static resume.

**Existing scaffolding (dormant, built for Santiago, needs adaptation not a rewrite-from-zero):**
`api/chat.js`, `api/_shared/rag.js`, `api/_shared/prompt.js`, `src/FloatingChat.tsx`, `chatbot-prompt.txt`.
`chatbot-prompt.txt` needs a full persona/facts rewrite for me, not a find-replace — same for the RAG
source content the chat tool searches over.

**Rough scope (detail goes in `phase-2-chatbot-rag.md` when this starts):**
- Rewrite `chatbot-prompt.txt` persona/facts for me.
- Wire RAG source content to my real project/experience detail (respecting the same content-sensitivity
  rule as the site copy).
- Re-render `FloatingChat.tsx` in `src/main.tsx`.
- Re-add the RAG sync step to the build pipeline once there's real content to sync.
- Update LLM models to include Google Gemini models and remove OpenAI models.

**Depends on:** Phase 1 content being stable (RAG needs real source material to index).

---

## Phase 3 — Evals + Prompt-Injection Defense

**Goal:** the quality/safety layer that backs up the chatbot — automated eval suite + the 6-layer
prompt-injection defense described in the original README, both currently asserting facts about Santiago.

**Existing scaffolding (dormant):** `evals/` (71-case suite, deterministic + LLM-as-judge),
`tests/ops-contract.test.ts`, `tests/ops-dashboard.test.ts`. The injection-defense layers live inside
`api/chat.js`/`api/_shared/rag.js` and activate automatically once Phase 2's chat pipeline is wired up — this
phase is really about building the eval dataset that proves it and the chatbot both work correctly for my
content.

**Rough scope (detail goes in `phase-3-evals-defense.md` when this starts):**
- New eval dataset asserting facts about me, not Santiago.
- Verify/tune the 6-layer injection defense against my persona and content.
- Re-add the evals step to CI/build once the dataset is real.
- Update the evals to use Google Gemini models and remove OpenAI models.

**Depends on:** Phase 2 (nothing to eval or defend until the chatbot exists).

---

## Phase 4 — Voice Mode + `/ops` LLMOps Dashboard

**Goal:** voice interaction with the chatbot, and a password-protected `/ops` dashboard for observing it in
production (conversations, costs, RAG, security, evals, voice, prompts, system health).

**Existing scaffolding (dormant):** `src/useVoiceMode.ts`, `src/VoiceOrb.tsx`, `src/useAudioAnalyser.ts`,
`src/ops/`, `api/ops/`. The dashboard reads from Langfuse + Supabase — needs my own accounts for those
services before there's real data to show; currently routed at `/ops` but unlinked from the UI and non
functional without those accounts.

**Rough scope (detail goes in `phase-4-voice-ops.md` when this starts):**
- Set up my own Langfuse + Supabase accounts/projects.
- Wire voice mode into `FloatingChat.tsx`.
- Point `/ops` at real data; decide on its auth/password setup.
- Update the ops dashboard to use Google Gemini models and remove OpenAI models.
  - Swap out OpenAI's Realtime API with Google's equivalent, Live API. (this might be a large diff so consider splitting into smaller PRs)

**Depends on:** Phase 2 (voice needs a working text chatbot underneath it) and Phase 3 (dashboard's `Evals`/
`Security` tabs need the eval suite and defense layers to be real).
