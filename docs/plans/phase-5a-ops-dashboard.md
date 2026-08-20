# Phase 5a — `/ops` LLMOps Dashboard

Status: **✅ Done** — Investigate/Plan/Test/Implement all complete, verified end-to-end in a real browser
against real production data (89.3% eval pass rate — the actual Phase 4 result — rendering live on the
dashboard). Split out of the original Phase 5 (Voice Mode + `/ops`) during Phase 5's Investigate stage — see
`docs/plans/roadmap.md`'s Phase 5 intro for why. Depends on Phase 4 (the `Evals`/`Security` tabs need a real
eval suite and defense layers — done).

## 1. Investigation findings

### The backend is fully generic — no Santiago content found

Read all 7 endpoints in `cv-chat-service/api/ops/` (`auth.js`, `stats.js`, `traces.js`, `trace/[id].js`,
`evals.js`, `prompts.js`, `rag-stats.js`) plus `_shared/ops-auth.js`. Grepped for
`Santiago|santifer|Jacobo|Sevilla|Seville` across the whole directory: zero hits. `stats.js` aggregates
Langfuse trace data (cost, latency, safety scores, intent distribution, RAG activation) purely structurally —
nothing about it assumes Santiago's content or persona. Auth is a simple `OPS_DASHBOARD_SECRET` Bearer-token
check (`_shared/ops-auth.js`), already wired into every endpoint via `validateOpsAuth()`.

The frontend shell (`cv-ui/src/ops/OpsAuth.tsx`, `OpsDashboard.tsx`) has exactly two content strings to fix:
`document.title = 'LLMOps Dashboard | santifer.io'` and a header subtitle `<p>santifer.io</p>`. The
`OpsDashboard.tsx` composition (tabs: Conversations, Costs, Evals, Rag, Security, System, Voice —
`cv-ui/src/ops/tabs/*.tsx`) and the shared `useOpsApi.ts` hook (sessionStorage-cached fetch wrapper with
30s TTL, auto-redirect-to-auth on 401) are both generic — no persona coupling found.

### `/ops` is already routed, just unlinked and unconfigured

`cv-ui/src/main.tsx:101` has `<Route path="/ops" element={<OpsDashboard />} />` already, and hides
`GlobalNav`/other chrome on `/ops*` paths. Visiting `/ops` today would render `OpsAuth`, whose POST to
`/api/ops/auth` would 503 with "Dashboard not configured" — `OPS_DASHBOARD_SECRET` isn't set anywhere.
Confirms the roadmap's framing ("routed but unlinked and non-functional") precisely: it's not disconnected
code, it's unconfigured code.

### Three env vars are missing from `.env.local.example`

Grepped every `process.env.*` reference across `api/ops/`, `api/voice-*.js`, `api/cron/`, `_shared/ops-auth.js`
and diffed against `cv-chat-service/.env.local.example`. Missing: `OPS_DASHBOARD_SECRET` (the dashboard
password), `CRON_SECRET` (gates `api/cron/evaluate.js`), `ALERT_EMAIL` (where jailbreak/low-safety alerts get
sent via Resend — `RESEND_API_KEY` is already provisioned from Phase 2's jailbreak-alert feature, just needs
a destination address).

### Local dev has no route for `/api/ops/*` or `/api/voice-*` — same gap class Phase 4 fixed for evals

`scripts/dev-server.mjs`'s route table is `{ '/api/chat': ... }` only (explicit code comment: "Only /api/chat
exists today; /api/ops/*, /api/voice-*.js are Phase 4/5 dormant and not wired here yet" — that comment is now
stale re: Phase 4, needs updating once this lands too). `tests/ops-dashboard.test.ts` still defaults
`OPS_TEST_BASE_URL` to `http://localhost:3000` — the pre-split `vercel dev` convention, same bug class fixed
in Phase 4's `runner.ts`/`adversarial-test.ts`/`prompt-regression.ts`. **Verified `tests/ops-contract.test.ts`
does NOT have this issue** — it talks to Langfuse's REST API directly (`LANGFUSE_BASE_URL`), never touches
`cv-chat-service`'s own HTTP API, so no port fix needed there — only `ops-dashboard.test.ts` does. Right now
`/api/ops/*` is only reachable locally against a real Vercel deployment, not the local dev adapter.
`ops-dashboard.test.ts` is a genuinely useful, already-written 7-endpoint contract test (auth flow, auth
protection on all 5 data endpoints, response shape assertions) — worth getting running locally, not just
against production.

### `tests/ops-contract.test.ts` validates a real cross-file risk

Its docstring: "validates that Langfuse trace metadata matches what the ops dashboard expects. If someone
changes `chat.js` metadata format, these tests catch it BEFORE deploy." Confirms this isn't redundant with
`ops-dashboard.test.ts` (which tests the `/api/ops/*` response contract) — this one tests the upstream
`chat.js`→Langfuse→`/api/ops/*` data pipeline stays in sync. Worth keeping both, fixing both.

### `api/cron/evaluate.js` duplicates `scripts/evaluate-traces.ts` — decided to consolidate

Both run the identical job: fetch recent Langfuse traces, score them with an LLM-as-judge prompt
(`intent_category`, `response_quality`, `safety_score`, `is_jailbreak_attempt`), write scores back to
Langfuse. `scripts/evaluate-traces.ts` is manually run (`npm run evaluate-traces`) and got rewritten for
Taher in Phase 4 (also fixed a stale `claude-sonnet-4-5-20250929` model id → `claude-haiku-4-5-20251001`).
`api/cron/evaluate.js` runs automatically via Vercel Cron, still has the **exact same stale model id** and
100% Santiago content (`EVALUATOR_PROMPT` describes "Santiago Fernández... based in Seville, Spain"; alert
emails are from `"Santi Bot"`). Two independently-maintained copies of the same prompt is exactly the kind of
drift that caused the stale-model-id bug in the first place.

**Decision: consolidate into one shared module** (e.g. `api/_shared/evaluator.js` or similar) that both
`api/cron/evaluate.js` and `scripts/evaluate-traces.ts` import — one `EVALUATOR_PROMPT`, one model id, one
place to update when the persona/content changes. `scripts/evaluate-traces.ts` also has extra logic
(`--auto-generate` trace-to-eval test generation) that's script-only, not cron-relevant — the consolidation
needs to isolate exactly the shared part (the scoring call) from the script-only part (auto-generation).

### Bilingual remnants in the `/ops` contract — not yet decided

`stats.js` builds a `distributions.languages: { es: 0, en: 0 }` breakdown and `traces.js` supports a
`?lang=es` filter — both bilingual-era, and both now permanently no-op since `chat.js` stopped tagging traces
with a language at all (confirmed during Phase 4: "single-language site, no per-lang email branching
needed"). `tests/ops-dashboard.test.ts` asserts on both (`distributions.languages exists`,
`lang=es filter returns 200`). Same category of cleanup as Phase 4's `languages.json` deletion, but not yet
decided for this phase — flagging for the Plan stage rather than deciding unilaterally, since it touches a
test contract rather than being purely additive.

## 2. Decisions

- **Consolidate the duplicate evaluator logic** into one shared module used by both `api/cron/evaluate.js` and
  `scripts/evaluate-traces.ts`, rather than fixing the cron copy's content independently.
- **Remove the bilingual `lang`/`languages` dimension** from `stats.js`, `traces.js`, and both
  `tests/ops-*.test.ts` files — confirmed during the Plan stage, matching the Phase 4 precedent
  (`languages.json` deletion) and the locked English-only decision.
- **`/api/voice-*` stays unwired in the local dev adapter for this phase** — 5b is about to rewrite that whole
  subsystem's provider (OpenAI Realtime → Google Live API), so wiring a route for code that's getting replaced
  wholesale is wasted work. This wasn't an open Investigate question, but worth stating explicitly since the
  Investigate doc left it unresolved.

## 3. Plan

### 3.1 Local dev/test infra

- **`scripts/dev-server.mjs`**: extend the flat `routes` table with the 6 static `/api/ops/*` endpoints
  (`auth`, `stats`, `traces`, `evals`, `prompts`, `rag-stats`). Route lookups must match on the URL's
  **pathname only** (`nodeReq.url.split('?')[0]`), not the raw `nodeReq.url` — several of these endpoints take
  query params (`stats?days=3`, etc.), and the current `/api/chat`-only table never had to handle that since
  chat takes none (Test-stage finding, confirmed this breaks every parameterized endpoint if skipped).
  `trace/[id].js` is a dynamic route that can't match the exact-string table — add a prefix check on the same
  stripped pathname (`pathname.startsWith('/api/ops/trace/')`) before the table lookup, dispatching straight
  to `trace/[id].js`'s handler; no handler change needed, since it already parses the id off `req.url` itself.
  Explicitly do **not** add `/api/voice-*` routes (Decision above). Update the file's stale "Phase 4/5 dormant"
  comment to reflect the new state (`/api/ops/*` wired, `/api/voice-*` still not — that's 5b's job). Verified
  in Test stage: this exact design, run for real, correctly handled query params, auth rejection, and the
  dynamic trace route.
- **`tests/ops-dashboard.test.ts`**: change `OPS_TEST_BASE_URL`'s default from `http://localhost:3000` to
  `http://localhost:8787`, matching `dev-server.mjs`'s actual port (same fix pattern as Phase 4's
  `CHAT_API_URL`). Also needs `OPS_DASHBOARD_SECRET` set to a real value for `testAuth()`'s "correct password"
  case to mean anything locally — currently defaults to a throwaway `'test-ops-secret-123'` string, which only
  works if the real dev server is also configured with that same value; document this in the test file's
  header comment so it's not a silent footgun.
- **`tests/ops-contract.test.ts`**: no port fix needed (confirmed in Investigate) — leave as-is.

### 3.2 Evaluator consolidation

- New file **`cv-chat-service/api/_shared/evaluator.js`** (plain JS, matching the existing `_shared/` module
  convention — `rag.js`, `prompt.js`, `ops-auth.js` are all plain JS, not TS). Exports:
  - `EVALUATOR_PROMPT` — the Taher-specific prompt, copied from `scripts/evaluate-traces.ts`'s current version
    (already correct/rewritten in Phase 4) — single source of truth going forward.
  - `evaluateTrace(userMessage, assistantResponse)` — async function wrapping the Anthropic call
    (`claude-haiku-4-5-20251001`, matching the Phase 4 fix) and JSON extraction, using a lazy-singleton client
    constructor (`getClient()`), mirroring the existing pattern in `evals/llm-judge.ts` rather than
    instantiating a fresh `Anthropic` client per call.
- **`scripts/evaluate-traces.ts`**: remove its local `EVALUATOR_PROMPT` constant and `evaluateTrace()`
  function; import both from `../api/_shared/evaluator.js` instead. Its CLI arg parsing, `.env.local` loading,
  main trace-fetch loop, and the `--auto-generate` trace-to-eval test-case generation (a distinct concern —
  generates new eval test cases from low-quality traces, not the same job as scoring) all stay untouched —
  only the per-trace scoring call changes from local function to import. Note: this is a `.ts` file importing
  a plain `.js` module with no type declarations — `cv-chat-service/tsconfig.json` has no `allowJs`, so this
  will type as `any` at the import boundary (acceptable — consistent with the existing "api/*.js files are
  plain JS, not TS" convention; not a regression, `tsc --noEmit` project-wide checks already have pre-existing
  gaps per the Phase 3 investigation).
- **`api/cron/evaluate.js`**: remove its local `EVALUATOR_PROMPT` constant (100% Santiago content) and the
  scoring portion of its Anthropic usage; import `evaluateTrace` from `../_shared/evaluator.js` instead. Keep
  its own `Anthropic`-independent logic (Langfuse trace fetching, scoring writeback, alert-email composition)
  as-is. Fix the alert email's `from: 'Santi Bot <onboarding@resend.dev>'` → `'TJ Bot <onboarding@resend.dev>'`
  (matches the existing convention already used in `api/_shared/rag.js`'s `sendJailbreakAlert`).
- **`cv-chat-service/vercel.json`**: currently just `{ "framework": null }` — no `crons` entry, so
  `api/cron/evaluate.js` isn't actually scheduled to run anywhere yet, dormant code notwithstanding. Add a
  `crons` array (e.g. daily) so this is real once deployed, per the file's own docstring intent ("Runs daily
  to evaluate recent traces"). `CRON_SECRET` (already read by the handler) gates it from being triggered by
  anyone else — Vercel Cron sends this automatically once configured.

### 3.3 Dashboard content + env provisioning

- **`cv-ui/src/ops/OpsAuth.tsx`** (line ~74) and **`OpsDashboard.tsx`** (lines ~38, ~99): replace the three
  `santifer.io` strings. Import `PROFILE` from `../cv-data` (not yet imported in either file) and use
  `PROFILE.name` ("Taher Jamali") in place of the domain string — there's no real domain yet (Phase 1's
  explicitly-deferred item), so branding on identity rather than a placeholder `*.vercel.app` URL is the more
  durable choice.
- **`cv-chat-service/.env.local.example`**: add `OPS_DASHBOARD_SECRET` (a password, not a hex secret — it's
  typed into a literal `<input type="password">` and compared directly in `auth.js`, so pick something
  memorable, not `crypto.randomBytes`-generated like `CHAT_SERVICE_SECRET`), `CRON_SECRET` (machine-to-machine,
  Vercel Cron → the endpoint — generate like `CHAT_SERVICE_SECRET`:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), `ALERT_EMAIL` (real destination
  address, e.g. `taher2152@gmail.com`, matching `PROFILE.email`). Real values go in `.env.local` (local) and
  the `cv-chat-service` Vercel Project's dashboard (production) — provisioning real secrets is something only
  the account owner does, same as every prior phase's env var additions.
- **Bilingual dimension removal** (Decision above): remove `distributions.languages` from `stats.js`'s
  aggregation and response shape; remove the `lang` query param and its tag-filter branch from `traces.js`;
  remove the matching assertions from both `tests/ops-dashboard.test.ts` (`distributions.languages exists`,
  `lang=es filter returns 200`) — `tests/ops-contract.test.ts` doesn't reference either, no change needed
  there. Leave the `es`/`en` tag values themselves alone in Langfuse's historical data (this only stops
  reading/surfacing that dimension going forward, doesn't touch stored traces).

### 3.4 Regenerate real eval data for the dashboard (found during Test stage, not in original Investigate)

- **`api/ops/_eval-results.json`/`.js`** are a committed, static snapshot from Santiago's last eval run
  (2026-07-30, 73 tests across the old 10-category bilingual structure) — missed entirely during Investigate,
  since I hadn't read `api/ops/evals.js` closely enough to notice it serves a static file rather than live
  data. `scripts/embed-evals.ts` (fully generic, no persona coupling) is the generator — parses the latest
  `evals/results/report-*.md` and writes both files. Its docstring claims it's "called automatically during
  `npm run build`" — verified that's false, it's not wired into any npm script. Fix: run it for real against
  the Phase 4 report and commit the regenerated output; note the stale doc claim needs correcting too.
- **Found and fixed a real bug in `embed-evals.ts`'s parser** while validating this: `parseReport()`'s
  section-split regex (`content.split(/### (.+)\n/)`) also matches four-hash test headers (`#### ❌ testId`
  contains `### ` as a substring), so every category's detail section gets truncated right before its first
  test — `cat.tests` (and therefore the output's `failedTests` array) end up empty regardless of content. This
  isn't new — the stale committed `_eval-results.js` already had `"failedTests":[]` despite `"failed":5`, so
  it's been silently broken since Santiago's era too, just never verified with real failing data. Fix:
  anchor the split regex to `/^### (.+)$/m` (exact three-hash line start, multiline flag) so it stops matching
  four-hash headers. Verified the fix directly: parsed the real Phase 4 report and confirmed all 9 categories'
  test counts match their expected totals exactly, and `failedTests` correctly lists all 6 `voice_quality`
  failures (previously always `[]`).
- **Minor, explicitly deferred**: the fixed parser still falls back to a generic `"Assertion failed"` reason
  for tests that errored (rather than failed an assertion) — e.g. `voice_quality`'s actual `RAG search API
  error: 404 Not Found` doesn't make it into the reason string, because `evals/runner.ts`'s `generateReport()`
  never writes the caught error message into the markdown report for errored tests in the first place. That's
  a Phase 4 file (already shipped/closed), and the dashboard still correctly shows the real pass/fail counts
  and which specific tests failed — just with a less specific reason for the errored ones. Not blocking this
  phase; noting it as a possible small follow-up rather than reopening Phase 4's scope.

### 3.5 Not in scope for 5a

- Anything in `cv-ui/src/ops/tabs/VoiceTab.tsx` — it'll render against real (likely empty) data once wired,
  which is correct/expected behavior until 5b actually produces voice traces. No changes needed to it now.
- `/api/voice-*` local routing and content (Decision above — 5b).

## 4. Suggested commit order

Provisional grouping for the Implement stage, following the same pattern as Phase 4's 3-commit split (group
by logical concern, one-liner message per commit, review the actual diff before finalizing — real
implementation may reveal a different natural boundary than this upfront guess). Five commits (grew from 4
during the Test stage — the eval-data regeneration turned out to be its own self-contained unit, not a fit for
either neighboring commit), in this order so each one leaves the tree in a working state:

1. **Local dev/test infra + bilingual cleanup** — `scripts/dev-server.mjs` (route table + the stale "Phase
   4/5 dormant" comment), `tests/ops-dashboard.test.ts` (port fix + dropped bilingual assertions),
   `api/ops/stats.js`/`api/ops/traces.js` (dropped `languages`/`lang` dimension). `tests/ops-contract.test.ts`
   isn't touched (confirmed no port dependency, doesn't reference the bilingual dimension). Bundling the
   bilingual-dimension removal here rather than with the dashboard-content commit, since it's really the same
   "clean up the `/ops` API + test contract" unit as the port fix, touching the same test file — avoids
   editing `ops-dashboard.test.ts` in two separate commits. Mirrors Phase 4's commit 1 (`4042f0a`) — makes the
   rest of this phase's work locally testable before touching any content, same reasoning as last time.
   Validated for real in Test stage: extended route table tested against live handlers (query-param parsing,
   dynamic `trace/[id]` dispatch, auth rejection) — all confirmed working.
   *Draft message: "Wire /api/ops/* into the local dev adapter, drop the dead bilingual dimension"*

2. **Evaluator consolidation** — new shared module `api/_shared/evaluator.js`, `api/cron/evaluate.js`
   rewritten to use it (plus the `Santi Bot`→`TJ Bot` sender fix), `scripts/evaluate-traces.ts` updated to
   import the shared piece instead of its own copy, `vercel.json`'s new `crons` entry so the job is actually
   scheduled. Self-contained refactor + content fix, independent of the dashboard UI work below. Validated for
   real in Test stage: a scratch version of the shared module, imported from a tsx-run `.ts` file, successfully
   called the live Anthropic API and parsed a real response — confirms the cross-context (Node script +
   Edge/Node function) plain-`.js`-module import works as designed.
   *Draft message: "Consolidate duplicate evaluator logic into a shared module, schedule the cron job"*

3. **Regenerate real eval data for the dashboard** — `scripts/embed-evals.ts` (fix the section-split regex
   bug, correct the stale "called automatically during npm run build" docstring claim), `api/ops/
   _eval-results.json`/`.js` (regenerated from the real Phase 4 report, replacing Santiago's stale 2026-07-30
   snapshot). Found and fully validated during the Test stage (§3.4) — independent of both neighboring
   commits, so it gets its own.
   *Draft message: "Fix embed-evals.ts parser bug, regenerate real eval data for the dashboard"*

4. **Dashboard content + env provisioning** — `OpsAuth.tsx`/`OpsDashboard.tsx` branding fix (`PROFILE.name`
   import), `.env.local.example` additions (`OPS_DASHBOARD_SECRET`, `CRON_SECRET`, `ALERT_EMAIL`). Small,
   low-risk content/config edits with no shared code dependency on commits 1–2.
   *Draft message: "Fix ops dashboard branding, provision required env vars"*

5. **Docs** — `docs/plans/phase-5a-ops-dashboard.md` (mark done, fill in the Implementation section),
   `docs/plans/roadmap.md` (5a status → done), `README.md`, `CLAUDE.md`. Same closing pattern as every prior
   phase.
   *Draft message: "Document Phase 5a (/ops dashboard) completion in roadmap and READMEs"*

As with every phase so far: show the actual staged diff per commit before committing, don't stage-and-commit
blind — the draft messages above are starting points, not final text, since they're written before the real
diff exists.

## 5. Test stage ✅ Done

Validated the three riskiest/most uncertain pieces of the plan with scratch work in
`process/scratch/phase-5a/` (gitignored, not committed), against real running code and real APIs — not just
code review:

- **Extended local dev routing** (§3.1): built a scratch copy of `dev-server.mjs` with the planned
  `/api/ops/*` route table and dynamic `trace/[id]` prefix-match, ran it for real on a throwaway port. Fixed
  one design gap the scratch run caught immediately: the route lookup needs to strip the query string before
  matching (`nodeReq.url` includes it, e.g. `/api/ops/stats?days=3`), or every parameterized endpoint 404s.
  Verified: unauthenticated/wrong-token requests correctly 401, the password-auth flow works, `stats.js` with
  a real `?days=3` query param correctly parsed it and returned real Langfuse data, and the dynamic
  `trace/[id]` route dispatched to the actual handler (not a router fallback — confirmed by its
  handler-specific error body, not a generic "Not found" string).
- **Evaluator consolidation cross-context import** (§3.2): built a scratch `api/_shared/evaluator.js`-shaped
  module and a tsx-run `.ts` importer, called it against the live Anthropic API. Confirmed the plain-`.js`
  shared module imports cleanly from a `.ts` script and executes correctly end-to-end (real API call, real
  JSON parse) — the cross-context design works exactly as planned, no changes needed.
- **Eval data freshness** (§3.4 — this whole finding came from Test-stage work, not Investigate): ran
  `scripts/embed-evals.ts` for real against the actual Phase 4 report. It correctly parsed the top-level
  numbers (50/56, matching Phase 4's real result exactly) but produced an empty `failedTests` array — traced
  this to a real regex bug (`### (.+)\n` also matching `#### ` four-hash headers), confirmed via a scratch
  debug script that a corrected anchored regex (`/^### (.+)$/m`) parses all 56 tests across all 9 categories
  correctly, including all 6 real `voice_quality` failures. Also confirmed via `stats.js`'s live response
  (`evalPassRate: 0.8928571428571429`) that the regenerated `_eval-results.json` flows through correctly to
  the dashboard's actual API output, not just the standalone script's output.

No blockers found. All three designs from the Plan stage hold up under real execution, with one small routing
fix (query-string stripping) and one real bug fix (the parser regex) folded into the Plan's scope above.

## 6. Implementation ✅ Done

Everything in the Plan's scope was implemented, plus two significant gaps found only during Implement — both
are documented here because they materially expand what shipped beyond the Plan stage's scope.

### Built as planned

- `scripts/dev-server.mjs`: extended route table (6 static `/api/ops/*` endpoints + dynamic `trace/[id]`
  prefix match), pathname-only matching, updated the stale comment.
- `tests/ops-dashboard.test.ts`: port fix (`:3000` → `:8787`), documented the `OPS_DASHBOARD_SECRET`
  requirement, updated the "start the server" error message.
- `api/_shared/evaluator.js` (new): the consolidated `EVALUATOR_PROMPT` + `evaluateTrace()`, exactly as
  validated in Test stage. `api/cron/evaluate.js` and `scripts/evaluate-traces.ts` both now import it instead
  of maintaining their own copies; `Santi Bot` → `TJ Bot` sender fix landed as part of this.
- `vercel.json` (`cv-chat-service`): added a `crons` entry so `api/cron/evaluate.js` actually runs (it never
  did before — no cron config existed).
- `scripts/embed-evals.ts`: fixed the section-split regex bug (found in Test stage) and the stale "called
  automatically during npm run build" docstring claim; ran it for real against the Phase 4 report.
  `api/ops/_eval-results.json`/`.js` now hold real Taher data (50/56, 89.3%) instead of Santiago's stale
  2026-07-30 snapshot.
- `OpsAuth.tsx`/`OpsDashboard.tsx`: `santifer.io` → `PROFILE.name` (imported from `cv-data.ts`), 3 occurrences.
- `.env.local.example`: added `OPS_DASHBOARD_SECRET`, `CRON_SECRET`, `ALERT_EMAIL` with guidance comments.

### Found during Implement: the bilingual removal was much bigger than scoped

The Plan (§3.3) only listed `stats.js`/`traces.js`/the test file for the bilingual-dimension removal. Actually
removing `distributions.languages` from the API response would have **crashed the Overview tab** —
`OpsDashboard.tsx` did `Object.entries(distributions.languages)` unguarded. Grepping the frontend surfaced 6
more files with real dependencies on the removed fields: `types.ts` (the TS interfaces), `OpsDashboard.tsx`
(the language donut chart — removed, grid changed from 3 to 2 columns), `FilterBar.tsx` (a language filter
`<select>`), `ConversationList.tsx` (a per-trace flag-emoji helper), `SecurityTab.tsx` (a per-trace language
badge), `ConversationsTab.tsx` and `hooks/useTraces.ts` (filter state plumbing). All fixed; `cv-ui`'s
`tsc -b --noEmit` is clean.

### Found during Implement: `/api/ops/*` had no route to reach `cv-chat-service` in production at all

This is the significant one. `cv-ui/src/ops/hooks/useOpsApi.ts` fetches `/api/ops/*` against
`window.location.origin` — same-origin, i.e. `cv-ui`'s own domain. But `cv-ui/api/` only ever contained
`chat.js`; there was no `cv-ui/vercel.json` rewrite either. In production, every single `/api/ops/*` call from
the dashboard would 404 against `cv-ui`'s own deployment — the entire dashboard's data layer simply doesn't
reach `cv-chat-service` at all. This is squarely a "make `/ops` work in production" gap, i.e. the core goal of
this phase, and it was missed in both Investigate and Plan because investigation only ever looked at
`cv-chat-service`'s side of `/api/ops/*`, never traced how the browser (on `cv-ui`'s separate domain) would
actually reach it.

Locally this was masked entirely: Vite's dev proxy forwards all `/api/*` to `cv-chat-service`'s dev port
regardless of path, so routing "worked" — but its `configure` hook (added in Phase 3, for `/api/chat`)
unconditionally overwrote the `Authorization` header on every proxied request with `CHAT_SERVICE_SECRET`,
clobbering the ops dashboard's own bearer token and always producing a 401 locally too. Caught via a real
Playwright login attempt, not code review.

Fixed both, following the already-established Phase 3 pattern (thin proxy function, `CHAT_SERVICE_URL` from
env, never hardcoded — not a static `vercel.json` rewrite, since those can't read env vars, the exact reason
Phase 3 rejected a rewrite for `/api/chat` too):

- `cv-ui/vite.config.ts`: scoped the `Authorization`-injecting `configure` hook to `/api/chat` only, so
  `/api/ops/*` requests pass the browser's own header through unmodified.
- `cv-ui/api/ops/[...path].js` (new): a catch-all proxy mirroring `api/chat.js`'s pattern, but without secret
  injection — `/api/ops/*` uses its own auth scheme (`OPS_DASHBOARD_SECRET`), carried by the browser itself,
  not something the proxy needs to attach. Forwards method, headers (including the real `Authorization`),
  query string, and body through to `${CHAT_SERVICE_URL}${pathname}${search}`.

Verified for real, not just reviewed: direct handler invocation of the new proxy (3 cases — authenticated GET
with query params, POST auth with wrong password, the dynamic `trace/[id]` route through the catch-all — all
correct), then a full Playwright run through the actual browser flow: login, dashboard renders with real data
(`89.3%` eval pass rate visible on screen, 2 donuts not 3, all 7 tabs present), zero console errors.

### Full verification

- `npx tsx tests/ops-dashboard.test.ts` against the real local dev server: **85/85 passed**, all 7 endpoints,
  auth + auth-protection on all 5 data endpoints, every trace filter combination.
- Real browser walkthrough (Playwright): login flow, Overview tab renders with live data including the real
  Phase 4 eval pass rate, zero console/page errors, screenshots confirm correct layout after the donut removal.
- `cv-ui` and `cv-chat-service` typechecks: no new errors introduced (one pre-existing implicit-`any` import
  boundary, accepted per the Plan §3.2 tradeoff; 4 pre-existing errors in `evaluate-traces.ts` confirmed via
  `git stash` to predate this phase's changes, all in code never touched here).

### Final commit grouping

The 5-commit plan held, with the two Implement-stage findings folded into their nearest logical commit rather
than becoming new ones — both are really "make the local/production wiring actually work" concerns, the same
job as commit 1:

1. **Local dev/test infra + bilingual cleanup + production routing fix** — now also includes
   `cv-ui/vite.config.ts`, `cv-ui/api/ops/[...path].js`, and the 6 additional frontend files from the
   bilingual-removal scope expansion, alongside the originally-planned `dev-server.mjs`/test-port/
   `stats.js`/`traces.js` changes.
2. **Evaluator consolidation** — as planned.
3. **Regenerate real eval data** — as planned.
4. **Dashboard content + env provisioning** — as planned.
5. **Docs** — this update.
