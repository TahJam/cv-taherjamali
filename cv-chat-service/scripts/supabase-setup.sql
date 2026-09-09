-- RAG Setup for Taher's chatbot
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
--
-- Embedding model: gemini-embedding-2, truncated to 768 dims via outputDimensionality
-- (Matryoshka representation) — see docs/plans/phase-2-chatbot-rag.md for why. The
-- original santifer.io schema used vector(1536) for OpenAI text-embedding-3-small;
-- 768 here is NOT a typo, it's the deliberate replacement.

-- 1. Enable pgvector extension
create extension if not exists vector with schema extensions;

-- 2. Create documents table
create table if not exists public.documents (
  id bigserial primary key,
  content text not null,
  metadata jsonb default '{}'::jsonb,
  embedding vector(768),
  fts tsvector generated always as (to_tsvector('english', content)) stored
);

-- 3. Hybrid search function (vector similarity + BM25 keyword match)
create or replace function hybrid_search (
  query_text text,
  query_embedding vector(768),
  match_count int default 10,
  semantic_weight float default 0.7,
  keyword_weight float default 0.3,
  filter jsonb default '{}'::jsonb
) returns table (
  id bigint, content text, metadata jsonb, similarity float
) language plpgsql as $$
begin
  return query
  select d.id, d.content, d.metadata,
    (semantic_weight * (1 - (d.embedding <=> query_embedding)) +
     keyword_weight * coalesce(ts_rank(d.fts, websearch_to_tsquery('english', query_text)), 0)
    ) as similarity
  from documents d
  where case when filter != '{}'::jsonb then d.metadata @> filter else true end
  order by similarity desc
  limit match_count;
end; $$;

-- 4. Delete function for re-indexing
create or replace function delete_documents_by_slug(slug text)
returns void language plpgsql as $$
begin
  delete from documents where metadata->>'article_id' = slug;
end; $$;

-- 5. Indices
create index if not exists documents_embedding_idx on documents
  using ivfflat (embedding vector_cosine_ops) with (lists = 10);
create index if not exists documents_fts_idx on documents using gin (fts);
create index if not exists documents_metadata_idx on documents using gin (metadata);

-- ---------------------------------------------------------------------------
-- 6. Voice-mode rate limiting (Phase 5b)
-- ---------------------------------------------------------------------------
-- api/voice-token.js's checkRateLimit() reads and upserts this table before
-- minting an ephemeral Live API token. It deliberately FAILS OPEN if the table
-- is missing, so an unprovisioned table means unlimited voice sessions with no
-- error anywhere — which is exactly what happened before Phase 5b added this.
-- The upsert relies on `Prefer: resolution=merge-duplicates`, so `ip` must be
-- unique for the merge to target an existing row.

create table if not exists public.voice_rate_limits (
  ip           text primary key,
  count        int not null default 0,
  window_start timestamptz not null default now()
);

create index if not exists voice_rate_limits_window_idx
  on public.voice_rate_limits (window_start);

-- ---------------------------------------------------------------------------
-- 7. Lock down: service_role bypasses RLS, so no policies are needed.
--    Zero policies = anon/authenticated match no rows.
-- ---------------------------------------------------------------------------
-- Every caller in cv-chat-service uses SUPABASE_SERVICE_ROLE_KEY server-side;
-- nothing in cv-ui ever touches Supabase. Without RLS, anyone holding the
-- (publicly-shippable by design) anon key could read/write these tables over
-- the project's REST API — including calling delete_documents_by_slug to wipe
-- the RAG index, or forging voice rate-limit rows.

alter table public.documents          enable row level security;
alter table public.voice_rate_limits  enable row level security;

revoke execute on function hybrid_search(text, vector, int, float, float, jsonb)
  from public, anon, authenticated;
revoke execute on function delete_documents_by_slug(text)
  from public, anon, authenticated;
