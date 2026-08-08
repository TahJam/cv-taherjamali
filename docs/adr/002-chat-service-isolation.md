# ADR-002: Chat/AI Backend Isolation

**Date:** 2026-08-06
**Status:** Accepted
**Decision makers:** Taher Jamali

## Context

Phase 2 wired up a live AI chatbot (`api/chat.js`, `api/_shared/rag.js`, `api/_shared/prompt.js`), deployed as
part of the same Vercel project as the static UI. While testing it locally, it became clear the chat pipeline
is architecturally a different thing from the rest of the site: it holds every external-service secret this
project has (Anthropic, Gemini, Supabase, Langfuse, Resend), it's the only part of the app with real backend
logic, and it's the part most worth isolating — both for local dev ergonomics (testing it doesn't require the
whole site) and for a real security boundary (nothing else should be able to reach it directly).

The initial framing was a three-way split — UI, "backend," and chat/AI service — modeled loosely on an AWS
pod, where multiple co-located services share a private network and can be deployed together relatively
easily. That framing needed two corrections: there's no actual "backend" responsibility in this app distinct
from the chat/AI concern (no user accounts, no other database writes, no business logic outside chat/RAG and
the dormant voice/`/ops` scaffolding — which are themselves AI-service concerns, not separate ones); and
Vercel, unlike an AWS VPC or a Kubernetes pod, has no private networking between separately deployed units —
everything, even two projects in the same account deployed from the same repo, communicates over public
HTTPS only.

## Decision

| Aspect | Choice | Why |
|--------|--------|-----|
| Service count | Two — UI, and one Chat/AI service | No third bucket of responsibility exists in this app today; voice and `/ops` (Phase 5) are AI-service concerns (same secrets, same data), not a separate backend |
| Separation depth | Physical — separate deploys, not just separate directories | The stated goal was a real isolation boundary (only the UI's server-side can reach the chat service), which a same-deployment logical split can't provide |
| Repo structure | npm workspaces monorepo: `cv-ui/` and `cv-chat-service/`, root `package.json` orchestrates | Full split, not just carving chat logic out of an otherwise-unchanged root — coherent, symmetric layout; npm workspaces needs no new tooling beyond `concurrently` |
| Hosting | Two Vercel Projects, same monorepo, Root Directory = `cv-ui` / `cv-chat-service` respectively | Stays on the free Hobby tier, no new hosting account, still one `git push` triggers both deploys |
| Cross-service auth | Application-level shared secret (UI server-side → chat service, verified header) | Vercel has no private networking between projects even in the same account — there is no network-level boundary to lean on instead |
| Local dev | `concurrently`-run separate processes, UI proxying to a local chat-service adapter | Matches a pattern already used successfully elsewhere; avoids requiring the Vercel CLI / `vercel dev` and any account-login step |

## Alternatives Considered

| Alternative | Why rejected |
|-------------|-------------|
| Three services (UI, backend, chat/AI) | "Backend" would have zero responsibilities today — empty infrastructure with a deploy pipeline, secrets, and a process to maintain for nothing |
| Logical separation only (same deploy, clean module boundary) | Doesn't provide an actual reachability boundary — anything that can call the UI's functions can call the chat functions too, since they're the same deployment |
| `vercel dev` for local emulation | Works, but requires installing the Vercel CLI and possibly logging in/linking the project; the `concurrently` + adapter pattern avoids that entirely and is a pattern already trusted from prior work |
| Host the chat service somewhere with real private networking (Fly.io, Railway, etc.) | Solves the network-isolation gap directly, but moves off the free Vercel tier this project is otherwise built around, and adds a second hosting account/pricing model to manage for a personal project |

## Consequences

- Two Vercel Projects means two sets of environment variables to manage in two dashboards, and two deploy
  histories to watch — more moving parts than the current single-project setup.
- CORS needs real configuration once the UI's browser-side and the chat service are on different origins (or
  the UI's own server-side proxies the call, keeping the browser same-origin — TBD in the Phase 3 plan).
- The shared secret becomes a real credential to rotate/manage, not just an internal implementation detail —
  same care as the other API keys already in `.env.local`.
- Local dev requires running two processes instead of one; the `concurrently` setup formalizes that but it's
  still more setup than `npm run dev` alone used to be.
- Cross-service calls now cross a real network hop (public HTTPS) instead of an in-process function call —
  added latency versus the current same-Vercel-project setup, though for a low-traffic personal site this is
  not expected to matter in practice.
