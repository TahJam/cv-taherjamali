# santifer.io

> Interactive portfolio with AI chatbot (text + voice), agentic RAG, 71 automated evals, LLMOps dashboard, and 6-layer prompt injection defense

[![Live Demo](https://img.shields.io/badge/demo-santifer.io-blue?style=flat-square)](https://santifer.io)
[![Built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-blueviolet?style=flat-square)](https://claude.ai/code)

---

<p align="center">
  <img src="docs/hero.gif" alt="santifer.io in motion" width="100%" />
</p>

---

## The Problem

Static CVs don't show what you can actually build. A PDF lists skills — it doesn't prove them.

## The Solution

A production-grade interactive portfolio that **demonstrates the skills it describes**: dual-mode AI chatbot (text + voice) with agentic RAG, full LLMOps observability with custom dashboard, 71 automated evals as CI gate, prompt versioning, and a closed-loop that generates tests from production failures.

**Key Features:**
- **AI Chatbot "Santi"** — Text (Claude Sonnet) + Voice (OpenAI Realtime API). Responds in first person as Santiago. Agentic RAG with hybrid search (pgvector + BM25) and Haiku reranking
- **6-Layer Defense** — Keyword detection, canary tokens, fingerprinting, anti-extraction, online safety scoring, adversarial red team. Real-time jailbreak email alerts
- **71 Automated Evals** — 10 categories: factual accuracy, persona, boundaries, quality, safety, language, RAG quality, multi-turn, source badges, voice quality. CI gate on every push
- **LLMOps Dashboard** — Private `/ops` with 8 tabs: Overview, Conversations, Costs, RAG, Security, Evals, Voice, System. Real data from Langfuse + Supabase
- **Closed Loop** — Trace → online scoring → quality < 0.7 → auto-generate test → CI gate blocks deploy
- **Voice Mode** — OpenAI Realtime API, audio-to-audio, shared RAG pipeline, ~$0.25/session
- **6 Published Case Studies** — Bilingual (ES/EN) with JSON-LD, prerendered HTML, cross-linked RAG, and interactive architecture diagrams
- **Interactive Architecture Diagram** — GSAP-animated SVG with narrated audio, pan/zoom, dark mode sync. [Explore it →](https://santifer.io/self-healing-chatbot#architecture)
- **GEO-ready** — `llms.txt`, structured data (JSON-LD), AI crawler-friendly robots.txt

---

## Tech Stack

![React](https://img.shields.io/badge/React_19-61DAFB?style=flat&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite_7-646CFF?style=flat&logo=vite&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind_v4-06B6D4?style=flat&logo=tailwindcss&logoColor=white)
![Claude](https://img.shields.io/badge/Claude_Sonnet-191919?style=flat&logo=anthropic&logoColor=white)
![OpenAI](https://img.shields.io/badge/OpenAI_Realtime-412991?style=flat&logo=openai&logoColor=white)
![Langfuse](https://img.shields.io/badge/Langfuse-000000?style=flat&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3FCF8E?style=flat&logo=supabase&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel_Edge-000000?style=flat&logo=vercel&logoColor=white)
![Recharts](https://img.shields.io/badge/Recharts-FF6384?style=flat&logoColor=white)

---

## Chatbot Architecture

[![Interactive Architecture Diagram](public/chatbot/diagram-thumbnail.webp)](https://santifer.io/self-healing-chatbot#architecture)
> **[Explore the interactive diagram →](https://santifer.io/self-healing-chatbot#architecture)** 10 phases · narrated audio · zoom + pan

```
User message → FloatingChat.tsx → api/chat.js (Vercel Edge)
                                    ├── System prompt (Langfuse registry + fallback)
                                    ├── Claude Sonnet (tool_use decision)
                                    ├── Agentic RAG (if needed):
                                    │     ├── OpenAI embeddings (text-embedding-3-small)
                                    │     ├── Supabase pgvector (semantic) + full-text (BM25)
                                    │     └── Claude Haiku (reranking + diversification)
                                    ├── Claude Sonnet (streaming generation)
                                    ├── Langfuse tracing (every span with cost)
                                    └── waitUntil → Haiku scoring (0ms added latency)

Voice mode → useVoiceMode.ts → api/voice-token.js → OpenAI Realtime WebSocket
                                  └── api/rag-search.js (function calling for RAG)
```

### Key Files

| File | Path | Description |
|------|------|-------------|
| Chat edge function | `api/chat.js` | Main chatbot — RAG, tracing, scoring, streaming, defense |
| RAG pipeline | `api/_shared/rag.js` | Hybrid search, reranking, cost tracking, intent classification |
| Prompt management | `api/_shared/prompt.js` | Langfuse prompt registry with file fallback |
| Voice token | `api/voice-token.js` | OpenAI Realtime ephemeral token + rate limiting |
| Voice RAG | `api/rag-search.js` | RAG search for voice mode function calling |
| Voice trace | `api/voice-trace.js` | Voice session tracing with cost estimation |
| Chat widget | `src/FloatingChat.tsx` | React widget — streaming SSE, quick prompts, contact CTA |
| Voice hook | `src/useVoiceMode.ts` | WebSocket management, audio capture, transcript persistence |
| System prompt | `chatbot-prompt.txt` | Fallback prompt (production uses Langfuse v5) |

---

## LLMOps Dashboard (`/ops`)

Private, password-protected dashboard with 8 tabs showing real production data:

| Tab | What it shows | Data source |
|-----|---------------|-------------|
| Overview | KPIs, timelines, donuts, intent distribution | Langfuse traces |
| Conversations | Filter + list + detail with spans, cost, latency, scores | Langfuse traces + observations |
| Costs | Breakdown per component (toolDecision/embedding/reranking/generation/voice) | `trace.metadata.cost` |
| RAG | Activation rate, chunks per article | Langfuse tags + Supabase |
| Security | Defense funnel, safety distribution, jailbreak list | Langfuse tags + scores |
| Evals | Pass rates by category (embedded from real eval reports) | `evals/results/` via build |
| Voice | Sessions, text/voice split, latency P50/P95, cost per minute | Langfuse tags |
| System | Prompt versions, RAG document stats, model pricing | Langfuse prompts API + Supabase |

### Dashboard API Layer

| Endpoint | Path | Description |
|----------|------|-------------|
| Auth | `api/ops/auth.js` | Login (validates `OPS_DASHBOARD_SECRET`) |
| Stats | `api/ops/stats.js` | Aggregated stats, server-side compute from traces |
| Traces | `api/ops/traces.js` | List traces with filters (lang, mode, RAG, jailbreak) |
| Trace detail | `api/ops/trace/[id].js` | Full trace with observations, scores, Langfuse link |
| Evals | `api/ops/evals.js` | Eval results embedded from build |
| Prompts | `api/ops/prompts.js` | Prompt versions from Langfuse |
| RAG stats | `api/ops/rag-stats.js` | Document stats from Supabase |

---

## Evals & Testing

71 automated tests across 10 categories. ~70% deterministic (contains, regex, word count), ~30% LLM-as-Judge (Haiku).

| Category | Tests | Type |
|----------|-------|------|
| factual_accuracy | 9 | Deterministic |
| persona_adherence | 4 | Deterministic |
| boundary_testing | 7 | Deterministic |
| response_quality | 7 | Mixed |
| safety_jailbreak | 7 | Deterministic |
| language_handling | 5 | Deterministic |
| rag_quality | 16 | Mixed |
| multi_turn | 5 | Mixed |
| source_badges | 5 | Deterministic |
| voice_quality | 6 | Mixed |

---

## Scripts & CLI Tools

All scripts live in `scripts/` and run via `npm run`:

### Chatbot Operations
| Command | Script | Description |
|---------|--------|-------------|
| `npm run evals` | `evals/runner.ts` | Run 71 automated evals |
| `npm run adversarial` | `scripts/adversarial-test.ts` | Red team: 20+ auto-generated attacks |
| `npm run chats` | `scripts/chats.ts` | View last 50 conversations from Langfuse |
| `npm run chats -- --full` | `scripts/chats.ts` | Full conversations with messages |
| `npm run chats -- --jailbreak` | `scripts/chats.ts` | Only jailbreak attempts |
| `npm run evaluate-traces` | `scripts/evaluate-traces.ts` | Batch eval with Haiku (quality, safety, intent) |
| `npm run diagnose:rag` | `scripts/diagnose-rag.ts` | RAG quality diagnostic — detects retrieval misses |

### Prompt & RAG Management
| Command | Script | Description |
|---------|--------|-------------|
| `npm run prompt:sync` | `scripts/sync-prompt-to-langfuse.ts` | Sync prompt to Langfuse (hash-based, skip if unchanged) |
| `npm run prompt:regression` | `scripts/prompt-regression.ts` | Compare two prompt versions side by side |
| `npm run rag:sync` | `scripts/export-chunks.ts` + `scripts/ingest-rag.ts` | Re-export articles + ingest to Supabase |

### Contract & Integration Tests
| Command | Script | Description |
|---------|--------|-------------|
| `npm run test:contract` | `tests/ops-contract.test.ts` | Validate trace metadata matches dashboard contract (67 tests) |
| `npm run test:ops` | `tests/ops-dashboard.test.ts` | Test all 7 dashboard API endpoints (102 tests) |

### Build Pipeline
| Command | Script | Description |
|---------|--------|-------------|
| `npm run build` | (chained) | rag:sync → prompt:sync → embed-evals → reddit-stats → tsc → vite → sitemap → validate → prerender |
| — | `scripts/embed-evals.ts` | Parse eval reports → embed in dashboard |
| — | `scripts/generate-sitemap.ts` | Generate sitemap.xml with lastmod |
| — | `scripts/validate-articles.ts` | SEO validation (dates, keywords, OG images) |
| — | `scripts/validate-llms-txt.ts` | Validate llms.txt consistency |
| — | `scripts/prerender.tsx` | SSR prerender all pages with critical CSS |
| — | `scripts/indexnow-ping.ts` | Ping Bing/Yandex on deploy |

---

## Quick Start

```bash
git clone https://github.com/santifer/cv-santiago.git
cd cv-santiago
npm install
npm run dev
```

Open [localhost:5173](http://localhost:5173)

### Environment Variables

```bash
# Core
ANTHROPIC_API_KEY=           # Claude API (chatbot)
OPENAI_API_KEY=              # Embeddings + Voice

# RAG
SUPABASE_URL=                # Supabase project URL
SUPABASE_SERVICE_ROLE_KEY=   # Supabase service key

# Observability
LANGFUSE_PUBLIC_KEY=         # Langfuse tracing
LANGFUSE_SECRET_KEY=         # Langfuse tracing

# Alerts & Dashboard
RESEND_API_KEY=              # Jailbreak email alerts
OPS_DASHBOARD_SECRET=        # Dashboard password (/ops)
```

---

## Project Structure

```
src/
├── App.tsx                  # Full CV — all sections
├── FloatingChat.tsx         # Chat widget (text mode)
├── useVoiceMode.ts          # Voice mode hook (OpenAI Realtime)
├── VoiceOrb.tsx             # Voice UI (orb + transcript)
├── GlobalNav.tsx            # Navigation with breadcrumbs
├── main.tsx                 # React Router + lazy loading
├── i18n.ts                  # Bilingual translations
├── articles/
│   ├── registry.ts          # Centralized article config
│   ├── components.tsx       # Shared article components
│   └── json-ld.ts           # JSON-LD builder
├── ops/                     # LLMOps Dashboard
│   ├── OpsDashboard.tsx     # Shell + Overview tab
│   ├── OpsAuth.tsx          # Login screen
│   ├── types.ts             # Shared TypeScript interfaces
│   ├── hooks/               # useOpsApi, useTraces
│   ├── components/          # KpiCard, MetricChart, FilterBar, etc.
│   └── tabs/                # Conversations, Costs, Security, Evals, etc.
├── [Article].tsx             # Case study components (5 articles)
└── [article]-i18n.ts         # Bilingual content per article

api/
├── chat.js                  # Main chatbot edge function
├── voice-token.js           # Voice ephemeral token + rate limit
├── voice-trace.js           # Voice session tracing
├── rag-search.js            # RAG for voice function calling
├── _shared/
│   ├── rag.js               # RAG pipeline (search, rerank, cost)
│   ├── prompt.js            # Prompt versioning (Langfuse)
│   └── ops-auth.js          # Dashboard auth helper
└── ops/                     # Dashboard API proxy layer
    ├── auth.js              # Login
    ├── stats.js             # Aggregated stats
    ├── traces.js            # Trace list with filters
    ├── trace/[id].js        # Trace detail
    ├── evals.js             # Eval results
    ├── prompts.js           # Prompt versions
    └── rag-stats.js         # RAG document stats

evals/
├── datasets/                # 10 JSON datasets (71 test cases)
├── assertions.ts            # Deterministic assertions
├── llm-judge.ts             # LLM-as-Judge (Haiku)
└── runner.ts                # Eval runner

scripts/                     # See "Scripts & CLI Tools" section above
tests/
├── ops-contract.test.ts     # Contract tests (67 assertions)
└── ops-dashboard.test.ts    # Dashboard API tests (102 assertions)

chatbot-prompt.txt           # System prompt (fallback, prod uses Langfuse)
```

---

## Case Studies

| Article | Slugs | Type |
|---------|-------|------|
| Self-Healing Chatbot | `/chatbot-que-se-cura-solo` `/self-healing-chatbot` | case-study |
| career-ops | `/career-ops` `/career-ops-system` | case-study |
| Jacobo AI Agent | `/agente-ia-jacobo` `/ai-agent-jacobo` | case-study |
| Business OS | `/business-os-para-airtable` `/business-os-for-airtable` | case-study |
| Programmatic SEO | `/seo-programatico` `/programmatic-seo` | case-study |
| n8n for PMs | `/n8n-para-pms` `/n8n-for-pms` | collab |
| Santifer iRepair | `/santifer-irepair` `/santifer-irepair-founder` | bridge |

---

## Cost

- **<$0.005 per text conversation** (5 models in the pipeline)
- **~$0.25 per voice session** (OpenAI Realtime)
- **$0 infrastructure** (free tiers: Vercel, Supabase, Langfuse)
- **~$30/month** estimated at 200 conversations/day

---

## License

MIT

---

## Let's Connect

[![Website](https://img.shields.io/badge/santifer.io-000?style=for-the-badge&logo=safari&logoColor=white)](https://santifer.io)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://linkedin.com/in/santifer)
[![Email](https://img.shields.io/badge/Email-EA4335?style=for-the-badge&logo=gmail&logoColor=white)](mailto:hi@santifer.io)
