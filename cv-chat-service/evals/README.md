# Evals Suite — TJ Chatbot

Automated eval suite for TJ, the chatbot that represents Taher Jamali on his CV site.

## What evals are

**Evals** are systematic tests that measure the quality of an AI system:

- **Accuracy** — Does it answer with correct information?
- **Persona adherence** — Does it stay in character?
- **Safety** — Does it decline what it should decline?
- **Quality** — Are responses useful and concise?

## Test categories

| Category | File | Tests |
|---|---|---|
| `factual_accuracy` | `factual.json` | 9 |
| `persona_adherence` | `persona.json` | 4 |
| `boundary_testing` | `boundaries.json` | 7 |
| `response_quality` | `quality.json` | 7 |
| `safety_jailbreak` | `safety.json` | 7 |
| `multi_turn` | `multi-turn.json` | 5 |
| `rag_quality` | `rag.json` | 8 |
| `source_badges` | `source-badges.json` | 3 |

50 active test cases. `rag.json`/`source-badges.json` are intentionally reduced-scope — they test
single-source (`llms.txt`, `article_id: "home"`) retrieval quality rather than multi-article
disambiguation, since no case-study articles exist yet (`ARTICLE_KEYWORDS`/`ARTICLE_ROUTES` in
`api/_shared/rag.js` are still empty). Full per-article coverage returns once real case studies are written —
see `docs/plans/phase-4-evals-defense.md`.

`voice.json` (6 tests) also lives in `datasets/` but is **deferred, untouched, and expected to fail/error**
right now — it exercises `/api/rag-search`, which isn't wired into the local dev adapter's route table
(`scripts/dev-server.mjs` only serves `/api/chat` today). It targets voice mode, which is dormant and about to
change architecture entirely (OpenAI Realtime → Google Live API) in Phase 5. Don't treat its failures as a
regression — leave it alone until that phase starts.

## How to run

First, copy `.env.example` to `.env.local` and fill in `CHAT_SERVICE_SECRET` (same value as
`cv-chat-service/.env.local`) and `ANTHROPIC_API_KEY` — `runner.ts` loads `evals/.env.local` automatically.

**Local (recommended for development):**
```bash
# Terminal 1: start the chat service's local dev adapter
npm run dev --workspace=cv-chat-service   # serves cv-chat-service on :8787

# Terminal 2: run the evals
npm run evals --workspace=cv-chat-service
```

**Against a deployed cv-chat-service** (to validate a real deploy):
```bash
CHAT_API_URL=https://your-chat-service.vercel.app/api/chat \
CHAT_SERVICE_SECRET=<the deployed CHAT_SERVICE_SECRET> \
npm run evals --workspace=cv-chat-service
```

> **Note:** plain `npm run dev` from the repo root (Vite) does not serve `/api/chat` on its own — it proxies to
> the adapter above. There is no Vercel CLI installed, so `vercel dev` isn't an option here; see
> `docs/plans/phase-3-service-split.md` for why the dev adapter exists.

## Directory structure

```
evals/
├── README.md            # this file
├── .env.example          # copy to .env.local — CHAT_SERVICE_SECRET + ANTHROPIC_API_KEY
├── datasets/              # tests, one JSON file per category
│   ├── factual.json, persona.json, boundaries.json, quality.json, safety.json, multi-turn.json
│   ├── rag.json, source-badges.json   # reduced scope, see above
│   └── voice.json                      # deferred to Phase 5, untouched
├── assertions.ts           # deterministic assertion functions
├── llm-judge.ts             # Claude Haiku subjective evaluator
├── runner.ts                 # main runner script
└── results/                   # generated reports (gitignored)
```

## Assertion types

### Deterministic (most tests)

| Type | Description |
|---|---|
| `contains` | Contains exact text |
| `contains_any` | Contains at least one of the given values |
| `not_contains` | Does NOT contain the text |
| `max_words` | At most N words |
| `min_words` | At least N words |
| `regex` | Matches a regex pattern |
| `rag_used` / `rag_not_used` | RAG search was (or wasn't) triggered |
| `source_includes` / `source_not_includes` | A specific `article_id` is (or isn't) among the RAG sources |

### LLM judge (subjective tests)

| Type | Description |
|---|---|
| `llm_judge` | Claude Haiku evaluates against a subjective criterion |

## Dataset format

```json
{
  "name": "category_name",
  "description": "What this dataset evaluates",
  "tests": [
    {
      "id": "test-id",
      "description": "What this test checks",
      "input": "Question to ask the chatbot",
      "assertions": [
        { "type": "contains", "value": "expected text" },
        { "type": "llm_judge", "criteria": "subjective criterion" }
      ],
      "conversation": "optional — prior turns for multi-turn tests"
    }
  ]
}
```

## Results

Each run generates a report at `results/report-YYYY-MM-DD.md` with:

- Overall summary and pass rate
- Pass rate per category
- Per-test detail: input, response, and each assertion's result

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CHAT_API_URL` | `http://localhost:8787/api/chat` | Chat API URL to test against |
| `CHAT_SERVICE_SECRET` | (required) | Must match `cv-chat-service`'s shared secret — the API rejects unauthenticated requests since the Phase 3 service split |
| `ANTHROPIC_API_KEY` | (required for LLM judge) | Anthropic API key |

Copy `.env.example` to `.env.local` and fill in real values (gitignored, never pushed to GitHub).
