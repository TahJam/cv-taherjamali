# Phase 3 — Service Split: Isolate the Chat/AI Backend

Status: **✅ Done** — Investigate/Plan/Test/Implement all complete, verified end-to-end locally (curl +
real browser test). Decision context: `docs/adr/002-chat-service-isolation.md`. Remaining: actual Vercel
deployment of both projects, which only the account owner can do (see roadmap's "Explicitly deferred").

## 1. Investigation findings

### Runtime dependency footprint is small

Checked every `import` in `api/chat.js`, `api/_shared/rag.js`, `api/_shared/prompt.js`: `@anthropic-ai/sdk`,
`langfuse`, `@vercel/functions` (for `waitUntil`), plus `chatbot-prompt.txt` as a raw-text import. Notably,
**`rag.js` has zero SDK dependency on Supabase or Google** — both `searchDocuments` (Supabase) and
`embedQuery` (Gemini) already use raw `fetch()` against REST endpoints, by design (Edge-runtime-compatible,
no heavy client library). This means the new chat service's `package.json` can be genuinely minimal — three
runtime dependencies, not a copy of the UI's full dependency tree.

### A `vercel.json` rewrite can't do the secret injection safely

The obvious-looking approach — a static `rewrites` rule in the UI's `vercel.json` pointing `/api/chat` at the
chat service's URL — doesn't work for this. `vercel.json` is a plain checked-into-git JSON file with no env
var interpolation; a rewrite can't attach a dynamic `Authorization: Bearer <secret>` header without the
secret being a literal string in the file (i.e., committed to the public repo). **The UI side needs an actual
serverless function**, not a static rewrite — one that reads `process.env.CHAT_SERVICE_SECRET` at runtime and
attaches it to the outbound request. This is a real correction to the ADR's original framing, not just an
implementation detail.

### Recommended shape (revised 2026-08-07): full monorepo split, not just carving out chat-service

Original framing (chat logic moves to `chat-service/`, everything else stays at repo root) is superseded —
the UI itself also moves into its own directory, for a coherent three-tier layout:

```
cv-taherjamali/                  # repo root — orchestration + shared docs only, no app code
├── package.json                 # npm workspaces root: "workspaces": ["cv-ui", "cv-chat-service"]
│                                 # "dev" script uses concurrently to run both workspaces' dev servers together
├── docs/, reference/, process/   # cross-cutting, not tied to one service
├── CLAUDE.md, README.md
│
├── cv-ui/                        # Vercel Project 1 — Root Directory = cv-ui
│   ├── src/, public/, index.html, vite.config.ts, tsconfig*.json, eslint.config.js
│   ├── api/chat.js               # NEW: thin proxy only (not the real handler)
│   ├── package.json               # own dependencies — react, vite, tailwind, etc.
│   ├── vercel.json                # UI's headers/CSP/redirects (as today)
│   └── .env.local                 # CHAT_SERVICE_URL, CHAT_SERVICE_SECRET only
│
└── cv-chat-service/               # Vercel Project 2 — Root Directory = cv-chat-service
    ├── api/chat.js                # the REAL handler, moved as-is
    ├── api/_shared/rag.js, prompt.js
    ├── chatbot-prompt.txt
    ├── package.json                # minimal — @anthropic-ai/sdk, langfuse, @vercel/functions
    └── .env.local                  # ANTHROPIC_API_KEY, GOOGLE_API_KEY, SUPABASE_*, LANGFUSE_*,
                                     # RESEND_API_KEY, CHAT_SERVICE_SECRET
```

**Mechanism: npm workspaces.** Node/npm's built-in monorepo support — no new package manager, no new tool
beyond `concurrently` itself. The root `package.json` declares the two workspaces; `npm install` at the root
installs both sub-projects' dependencies (one `node_modules` at root, hoisted, standard npm workspaces
behavior); each sub-project keeps its own `package.json` for its own dependency list and scripts.

**Each sub-project gets its own `.env.local`, not one shared root file.** This mirrors having two separate
Vercel Projects with two separate env var dashboards in production — the UI's env should not contain
`ANTHROPIC_API_KEY` etc., and the chat service's shouldn't contain anything UI-specific. Requires splitting
your current single root `.env.local` into two once we implement.

**`CHAT_SERVICE_URL` is an env var, never hardcoded** (per your Decision 2) — locally it points at
`http://localhost:<chat-service-dev-port>`, in production at the real `*.vercel.app` URL. Dev vs. prod is
purely a difference in that one env var's value, same proxy code path either way.

- **UI's `api/chat.js` becomes a thin proxy**: reads the incoming request, forwards it to
  `${CHAT_SERVICE_URL}/api/chat` with the shared secret attached, and returns the upstream `Response`
  (including its streaming body) directly back to the browser — `return new Response(upstreamRes.body, {
  headers: upstreamRes.headers, status: upstreamRes.status })`, no buffering.
- **Why a proxy instead of the browser calling the chat service directly with CORS:** a secret sent from
  browser JS is visible in devtools/Network tab to any visitor — that defeats the entire point of "only the
  UI can reach the chat service." The proxy keeps the secret server-side only, and keeps the browser's request
  same-origin (no CORS configuration needed on the UI's own domain).

### What moves where (Phase 3 scope only — Phase 4/5 dormant files noted but not moved yet)

| Goes to `cv-chat-service/` now | Goes to `cv-ui/` | Stays at repo root |
|---|---|---|
| `api/chat.js`, `api/_shared/rag.js`, `api/_shared/prompt.js`, `chatbot-prompt.txt` | `src/`, `public/`, `index.html`, `vite.config.ts`, `tsconfig*.json`, `eslint.config.js` | `docs/`, `reference/`, `process/`, `CLAUDE.md`, `README.md` |
| `scripts/export-chunks.ts`, `ingest-rag.ts`, `supabase-setup.sql`, `sync-prompt-to-langfuse.ts`, `prompt-regression.ts`, `update-prompt.sh` | `scripts/generate-sitemap.ts`, `generate-rss.ts`, `generate-og-image.ts`, `prerender.tsx`, `validate-*.ts`, `indexnow-ping.ts`, `gsc-*.py`, `check-console-errors.ts`, `update-*-stats.ts`, `og-template.html` | `.gitignore`, `.github/` |
| `.rag-hashes.json`, `scripts/chunks/` (generated) | new thin `api/chat.js` (proxy) | `project_portfolio.md` (private, unrelated to code) |

**Not moved yet (Phase 4/5 territory, left in place until those phases actually start — moving them now would
be scope creep beyond what Phase 3 needs):** `api/ops/*`, `api/_shared/ops-auth.js`, `api/cron/evaluate.js`,
`api/voice-token.js`, `api/rag-search.js`, `api/voice-trace.js`, `evals/`, `tests/ops-*.test.ts`,
`scripts/adversarial-test.ts`, `chats.ts`, `chats-tui.ts`, `diagnose-rag.ts`, `evaluate-traces.ts`,
`embed-evals.ts`. These conceptually belong in `cv-chat-service/` per the locked architecture decision, but
Phase 3's job is proving the split works for the one thing that's actually live (`chat.js`) — dragging five
dormant, untouched-since-the-fork subsystems along for the move multiplies the surface area for something to
break, for zero functional benefit until those phases actually start.

### The streaming passthrough is the biggest real unknown — needs Test-stage validation

Everything else here is fairly mechanical (header-checking, minimal deps, directory layout). Whether an Edge
Function can `fetch()` another Edge Function's streaming SSE response and pass it through *without buffering*
is the one piece I haven't verified. If Vercel buffers the whole upstream response before the proxy can
return it, the word-by-word streaming UX breaks — the user would see nothing, then the full answer dumps at
once. This needs a real test, not an assumption, before committing to the proxy approach.

### Local dev: simpler than initially assumed

The naive version needs three concurrent local processes (Vite, a local adapter for the UI's own proxy
function, a local adapter for the chat service). That's one more moving part than necessary: **in dev, Vite's
own `server.proxy` config can route `/api/*` directly to the chat-service adapter's port**, skipping the
UI-proxy-function hop entirely — the secret-injection proxy is a production cross-origin/security concern,
and in local dev everything is `localhost` anyway. That leaves exactly two concurrent processes: Vite (UI) and
a small Fetch-API-compatible local HTTP adapter around the chat service's handler — the same adapter pattern
already built and proven working in Phase 2's Test stage (`process/scratch/phase-2/test-chat-handler.ts` +
`txt-loader.mjs`), just promoted from a scratch script into a real `npm run dev:chat` script.

## 2. Decisions (resolved 2026-08-07)

- **Full monorepo split, three tiers:** root (orchestration + shared docs, no app code) — `cv-ui/` — 
  `cv-chat-service/`. Not just "carve chat logic out of an otherwise-unchanged root" as originally scoped;
  the UI moves too, for a coherent, symmetric structure. Names: `cv-ui`, `cv-chat-service`.
- **npm workspaces**, root `package.json` orchestrates via `concurrently` — no new package manager, no new
  monorepo tool beyond `concurrently` itself.
- **Two Vercel Projects**, default `*.vercel.app` URLs for now (no custom domain yet either way — consistent
  with the existing Phase 1 deferral). `cv-ui` Root Directory → Project 1, `cv-chat-service` Root Directory →
  Project 2.
- **`CHAT_SERVICE_URL` is always an env var, never hardcoded** — local dev points it at
  `http://localhost:<port>`, production at the real deployed URL. Same proxy code path either way, only the
  env var value differs.
- **Shared secret: a single static `CHAT_SERVICE_SECRET` env var**, identical in both Vercel dashboards and
  both `.env.local` files. No rotation tooling, no signed tokens — deliberately simple for a two-service
  personal project; explicitly rejected as unnecessary complexity.
- **Each sub-project gets its own `.env.local`**, not one shared root file — mirrors the two separate Vercel
  dashboards. Your current root `.env.local` gets split: `CHAT_SERVICE_URL`/`CHAT_SERVICE_SECRET` into
  `cv-ui/.env.local`; `ANTHROPIC_API_KEY`/`GOOGLE_API_KEY`/`SUPABASE_*`/`LANGFUSE_*`/`RESEND_API_KEY`/
  `CHAT_SERVICE_SECRET` into `cv-chat-service/.env.local`.
- **Phase 4/5 dormant files stay put for now** — `api/ops/*`, voice API files, `evals/`, eval/ops-adjacent
  scripts. They conceptually belong in `cv-chat-service/` eventually, but moving five untouched dormant
  subsystems now is scope creep beyond proving the split works for what's actually live.

## 3. Test stage — results (2026-08-07)

- **Streaming passthrough test — ✅ passed.** Before trusting the pattern, checked whether this is a known
  Vercel gotcha: it is — Vercel's Node.js Serverless runtime has reported production-only buffering (works
  locally, bursts on deploy), Edge Functions (what `chat.js` already uses) are the documented fix, and adding
  `X-Content-Type-Options: nosniff` resolved real-world reports of the same issue. Built a real two-process
  local test (`process/scratch/phase-3/upstream-server.mjs` + `proxy-server.mjs` + `streaming-test-client.mjs`)
  — a real HTTP server streaming SSE with realistic 300ms inter-chunk delays, and a real proxy in front of it
  using the exact pattern the production code will use (pass the fetched `Response`'s `ReadableStream`
  straight through via `Readable.fromWeb(upstreamRes.body).pipe(res)` — the Node equivalent of an Edge
  Function's `return new Response(upstreamRes.body, {...})`, no manual read-loop, nothing awaited before
  responding). Client measured actual wall-clock chunk arrival: 13 chunks arrived at ~300ms intervals over
  3.67s, matching the upstream's send timing exactly — not bursted at the end. **Caveat, stated plainly: this
  proves the code pattern itself doesn't introduce buffering. It does not prove Vercel's specific production
  infrastructure won't** — that gap can only close with a real deploy, which is an Implementation-stage step.
  Added `X-Content-Type-Options: nosniff` to the proxy's response headers as a defensive measure regardless,
  since it's a documented fix for exactly this class of issue.
- **npm workspaces + `concurrently` smoke test — ✅ passed.** Built a real two-workspace skeleton (throwaway,
  in the session scratchpad, not the repo) with a root `package.json` (`"workspaces": ["pkg-ui", "pkg-chat"]`,
  `concurrently`-based `dev` script) and two minimal sub-packages. `npm install` from root hoisted
  dependencies correctly (confirmed no `node_modules` inside either sub-package). `npm run dev` produced
  correctly interleaved, colored, prefixed output (`[UI]`/`[CHAT]`) from both processes running independently,
  clean exit on completion. This is exactly the mechanism the real root `package.json` will use.
- **Local Vite-proxy dev routing — not separately tested.** Vite's `server.proxy` is a thin, extremely
  well-established layer for exactly this local-API-proxying use case (built on Node's standard proxy
  primitives, which stream by default). Given the core streaming-passthrough risk was already validated
  above and Vite's dev proxy isn't part of the production path at all, standing up a redundant throwaway Vite
  project to re-prove a well-documented feature wasn't a good use of Test-stage effort — real verification
  happens naturally once `cv-ui/vite.config.ts` exists for real in Implementation.
- **Vercel monorepo build detection (workspace-root install) — not locally testable, documented as
  supported.** Vercel's own docs describe exactly this workflow (multiple Projects, different Root Directory,
  same repo) as a supported pattern; actually confirming it requires a real Vercel deploy with a real account,
  which is an Implementation-stage step, not something a local Test-stage script can fake.

## 4. Implementation steps (after Test stage confirms the approach)

1. Set up the npm workspaces skeleton: root `package.json` with `"workspaces": ["cv-ui", "cv-chat-service"]`
   and a `concurrently`-based `dev` script; empty `cv-ui/package.json` and `cv-chat-service/package.json`.
   Verify `npm install` from root + `npm run dev` (both sides trivially "hello world") before moving real code.
2. Move UI files into `cv-ui/`: `src/`, `public/`, `index.html`, `vite.config.ts`, `tsconfig*.json`,
   `eslint.config.js`, `vercel.json`, UI-relevant `scripts/*`. Split root `.env.local` — UI-relevant vars into
   `cv-ui/.env.local`.
3. Move chat files into `cv-chat-service/`: `api/chat.js`, `api/_shared/rag.js`, `api/_shared/prompt.js`,
   `chatbot-prompt.txt`, RAG-pipeline `scripts/*`, `.rag-hashes.json`. Chat-relevant vars into
   `cv-chat-service/.env.local`.
4. Add shared-secret verification to the chat service's handler (reject anything without a valid
   `CHAT_SERVICE_SECRET` match).
5. Replace `cv-ui/api/chat.js` with the thin proxy implementation, reading `CHAT_SERVICE_URL` +
   `CHAT_SERVICE_SECRET` from env — pass the upstream `Response`'s stream straight through
   (`return new Response(upstreamRes.body, {...})`), and include `X-Content-Type-Options: nosniff` on the
   response (Test-stage finding: a documented fix for Vercel production SSE buffering reports).
6. Add `dev:chat` (local Fetch-API adapter for `cv-chat-service`) and wire Vite's `server.proxy` in
   `cv-ui/vite.config.ts` to route local `/api/*` to it.
7. Set up the second Vercel Project (`cv-chat-service` as Root Directory), wire env vars in both dashboards,
   update the first project's Root Directory to `cv-ui` if not already implied by the restructure.
8. Update `CLAUDE.md`, `docs/plans/roadmap.md`, and `README.md` once verified working end-to-end in a real
   deploy — per the roadmap's own rule to keep these in sync each phase.
