# Taher Jamali — Digital CV

> Software Engineer — Machine Learning & Platform Security. I turn manual pentesting into systems that watch themselves.

[![License: MIT](https://img.shields.io/badge/license-MIT-informational?style=flat-square)](#license)
[![Built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-blueviolet?style=flat-square)](https://claude.ai/code)

This is a fork of [santifer.io](https://github.com/santifer/cv-santiago) (Santiago Fernández's AI-powered
portfolio), being turned into my own interactive CV — same idea (a site that demonstrates engineering skill
instead of just listing it), entirely new content, identity, and persona. See [Credits](#credits) below.

---

## What this is

A personal portfolio site built incrementally, phase by phase, rather than all at once. The end goal follows
Santiago's original pattern: real project content, an AI chatbot that can talk about that content in depth,
backed by real observability — not a static PDF pretending to be a website.

The full roadmap, including what's already done and what's planned for
each later phase, lives in **[`docs/plans/roadmap.md`](docs/plans/roadmap.md)**.

The scaffolding for this project already exists in this
repo from the original fork — real, working code, just built for Santiago's content and currently disconnected
from the live app. Each phase adapts that scaffolding rather than rebuilding from zero; see the roadmap for
detail on what's dormant where.

---

## Tech Stack

![React](https://img.shields.io/badge/React_19-61DAFB?style=flat&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite_7-646CFF?style=flat&logo=vite&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind_v4-06B6D4?style=flat&logo=tailwindcss&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel-000000?style=flat&logo=vercel&logoColor=white)

See [`docs/adr/001-tech-stack.md`](docs/adr/001-tech-stack.md) for why this stack was chosen (written by
Santiago for the original; still the rationale for what's kept).

---

## Quick Start

This is an npm workspaces monorepo — two physically separate services (`cv-ui/`, `cv-chat-service/`), one
`npm install` from the root sets up both.

```bash
git clone https://github.com/TahJam/cv-taherjamali.git
cd cv-taherjamali
npm install
npm run dev
```

`npm run dev` uses `concurrently` to run both services together with colored, prefixed logs (`[UI]`/`[CHAT]`)
— Vite for `cv-ui` on [localhost:5173](http://localhost:5173), and a small local adapter for
`cv-chat-service` on `:8787` (there's no Vercel CLI installed, so this stands in for `vercel dev`; see
`CLAUDE.md` for how it works). The UI's dev server proxies `/api/*` straight to the adapter, so the chat
widget works out of the box once both are running.

`cv-ui` needs no environment variables. `cv-chat-service` needs `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `CHAT_SERVICE_SECRET` — see
`cv-chat-service/.env.local.example`. `cv-ui` needs `CHAT_SERVICE_URL` and the same `CHAT_SERVICE_SECRET` —
see `cv-ui/.env.local.example`. `LANGFUSE_*`/`RESEND_API_KEY` are optional (tracing and jailbreak alerts; the
chat pipeline degrades gracefully without them).

---

## Project Structure

An npm workspaces monorepo — two physically separate deployable services, isolated on purpose (see
[`docs/adr/002-chat-service-isolation.md`](docs/adr/002-chat-service-isolation.md)). Repo root is orchestration
and shared docs only, no app code.

```
package.json                     # root: npm workspaces + concurrently orchestrator ("npm run dev" from here)

cv-ui/                           # Vercel Project 1 — the site
├── src/
│   ├── App.tsx                  # The entire homepage — hero, experience, projects, education, skills, contact
│   ├── cv-data.ts                # Single source of truth for homepage content — edit here, not App.tsx
│   ├── GlobalNav.tsx              # Theme toggle (minimal — no multi-page nav yet)
│   ├── main.tsx                   # Routes: / (App), /ops (dormant dashboard), catch-all 404
│   ├── FloatingChat.tsx            # Live chat widget — TJ persona, text-only
│   ├── articles/registry.ts        # Case-study registry — emptied of Santiago's, type shape kept for mine
│   ├── useVoiceMode.ts, VoiceOrb.tsx    # Dormant voice-mode UI — Phase 5
│   └── ops/                              # Dormant LLMOps dashboard frontend — Phase 5
├── api/chat.js                    # Thin proxy only — forwards to cv-chat-service with the shared secret
└── vite.config.ts                  # Dev-only /api/* proxy to the local chat-service adapter

cv-chat-service/                 # Vercel Project 2 — everything AI/chat
├── api/
│   ├── chat.js, _shared/rag.js, _shared/prompt.js    # Live chatbot + RAG pipeline
│   └── ops/, voice-*.js, cron/                         # Dormant — Phase 5, moved here since same concern
├── chatbot-prompt.txt              # TJ's system prompt
├── scripts/                         # RAG content pipeline (export-chunks, ingest-rag) + dev-server.mjs adapter
└── evals/                            # 50 active tests across 8 categories, rewritten for Taher/TJ — Phase 4

docs/
├── adr/                  # Architecture decision records
└── plans/                 # Roadmap + per-phase implementation plans (source of truth for status)

reference/santiago-original/    # Untouched copies of pre-rewrite files (App.tsx, i18n.ts, etc.) — never built
```

---

## License

MIT — see the original [cv-santiago](https://github.com/santifer/cv-santiago) repo for license terms, carried
over unchanged.

---

## Credits

This project is forked from [santifer.io](https://santifer.io)
([source](https://github.com/santifer/cv-santiago)), built by **Santiago Fernández**
([@santifer](https://github.com/santifer)). The architecture, the self-referential AI-chatbot-that-talks-about-
its-owner's-work concept, and a lot of the engineering underneath this site are his. This fork keeps the
pattern and the git history, and replaces the content, persona, and branding with my own as each phase lands.

## Contact

[![GitHub](https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/TahJam)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://linkedin.com/in/taher-jamali)
[![Email](https://img.shields.io/badge/Email-EA4335?style=for-the-badge&logo=gmail&logoColor=white)](mailto:taher2152@gmail.com)
