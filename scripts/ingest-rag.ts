/**
 * RAG Ingestion: embed chunks and upsert to Supabase pgvector.
 *
 * Features:
 *   - Change detection via content hashing (skip unchanged articles)
 *   - Chunk splitting for large sections (1000 chars, 200 overlap)
 *   - Contextual retrieval: prepend summary via Haiku before embedding
 *   - Gemini gemini-embedding-2 for embeddings, truncated to 768 dims
 *     (see docs/plans/phase-2-chatbot-rag.md for why this model/dimension)
 *   - Upsert to Supabase `documents` table
 *
 * Requires env vars:
 *   GOOGLE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   ANTHROPIC_API_KEY (optional, for contextual retrieval)
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.app.json scripts/ingest-rag.ts
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
config() // also load .env as fallback

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { articleRegistry } from '../src/articles/registry.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const CHUNKS_DIR = resolve(root, 'scripts/chunks')
const HASHES_FILE = resolve(root, '.rag-hashes.json')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_CHUNK_SIZE = 1000    // characters
const CHUNK_OVERLAP = 200      // characters
const EMBEDDING_MODEL = 'gemini-embedding-2'
const EMBEDDING_DIMENSIONS = 768
const EMBEDDING_BATCH_SIZE = 20

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

function requireGoogleApiKey(): string {
  if (!process.env.GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY is required')
  }
  return process.env.GOOGLE_API_KEY
}

function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

function getAnthropic(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChunkMetadata {
  article_id: string
  article_slug: string
  section_id: string
  section_anchor: string
  page_path: string
  source_file: string
  format: 'i18n' | 'markdown'
}

interface Chunk {
  content: string
  metadata: ChunkMetadata
}

// ---------------------------------------------------------------------------
// Hashing for change detection
// ---------------------------------------------------------------------------

function loadHashesFromFile(): Record<string, string> {
  try {
    if (existsSync(HASHES_FILE)) {
      return JSON.parse(readFileSync(HASHES_FILE, 'utf-8'))
    }
  } catch { /* ignore */ }
  return {}
}

async function loadHashesFromSupabase(supabase: ReturnType<typeof createClient>): Promise<Record<string, string>> {
  try {
    const { data, error } = await supabase
      .from('rag_hashes')
      .select('article_id, hash')
    if (error || !data) return {}
    const hashes: Record<string, string> = {}
    for (const row of data) hashes[row.article_id] = row.hash
    return hashes
  } catch { return {} }
}

async function loadHashes(supabase: ReturnType<typeof createClient>): Promise<Record<string, string>> {
  // Local file takes priority (faster), fallback to Supabase (for CI/Vercel)
  const local = loadHashesFromFile()
  if (Object.keys(local).length > 0) return local
  console.log('  ℹ️  No local hashes — checking Supabase...')
  return loadHashesFromSupabase(supabase)
}

async function saveHashes(hashes: Record<string, string>, supabase: ReturnType<typeof createClient>) {
  // Save locally
  writeFileSync(HASHES_FILE, JSON.stringify(hashes, null, 2))
  // Save to Supabase (for CI/Vercel where local file doesn't persist)
  try {
    const rows = Object.entries(hashes).map(([article_id, hash]) => ({ article_id, hash }))
    await supabase.from('rag_hashes').upsert(rows, { onConflict: 'article_id' })
  } catch { /* non-critical */ }
}

function hashContent(chunks: Chunk[]): string {
  const content = JSON.stringify(chunks.map(c => ({ content: c.content, metadata: c.metadata })))
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// Chunk splitting (for large sections)
// ---------------------------------------------------------------------------

function splitChunk(chunk: Chunk): Chunk[] {
  if (chunk.content.length <= MAX_CHUNK_SIZE) return [chunk]

  const parts: Chunk[] = []
  let start = 0

  while (start < chunk.content.length) {
    const end = Math.min(start + MAX_CHUNK_SIZE, chunk.content.length)
    const text = chunk.content.slice(start, end)

    parts.push({
      content: text,
      metadata: { ...chunk.metadata },
    })

    start = end - CHUNK_OVERLAP
    if (start >= chunk.content.length - CHUNK_OVERLAP) break
  }

  // Ensure last part is included if we missed it
  if (parts.length > 0) {
    const lastEnd = parts[parts.length - 1].content.length +
      (parts.length - 1) * (MAX_CHUNK_SIZE - CHUNK_OVERLAP)
    if (lastEnd < chunk.content.length) {
      parts.push({
        content: chunk.content.slice(chunk.content.length - MAX_CHUNK_SIZE),
        metadata: { ...chunk.metadata },
      })
    }
  }

  return parts
}

// ---------------------------------------------------------------------------
// Contextual retrieval: prepend summary via Haiku
// ---------------------------------------------------------------------------

async function addContextualSummaries(
  chunks: Chunk[],
  articleTitle: string,
  anthropic: Anthropic | null,
): Promise<string[]> {
  if (!anthropic) {
    console.log('    (no ANTHROPIC_API_KEY — skipping contextual retrieval)')
    return chunks.map(c => c.content)
  }

  const enriched: string[] = []

  for (const chunk of chunks) {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: `This chunk is from the article "${articleTitle}", section "${chunk.metadata.section_id}". Give a 1-2 sentence context summary that would help retrieve this chunk when relevant. Be specific about what information this chunk contains.\n\nChunk:\n${chunk.content.slice(0, 500)}`,
        }],
      })

      const summary = response.content[0].type === 'text' ? response.content[0].text : ''
      enriched.push(`${summary}\n\n${chunk.content}`)
    } catch {
      // Fallback: use content without summary
      enriched.push(chunk.content)
    }
  }

  return enriched
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

async function embedOne(text: string, apiKey: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: EMBEDDING_DIMENSIONS,
    }),
  })
  if (!res.ok) {
    throw new Error(`Gemini embedding failed: ${res.status} ${await res.text()}`)
  }
  const data = await res.json() as { embedding: { values: number[] } }
  return data.embedding.values
}

async function embedTexts(texts: string[], apiKey: string): Promise<number[][]> {
  const allEmbeddings: number[][] = []

  // Gemini's embedContent is single-text per call (no batch endpoint like
  // OpenAI's), so we chunk into small concurrent batches instead of one
  // request per text sequentially.
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE)
    const embeddings = await Promise.all(batch.map(text => embedOne(text, apiKey)))
    allEmbeddings.push(...embeddings)
  }

  return allEmbeddings
}

// ---------------------------------------------------------------------------
// Supabase operations
// ---------------------------------------------------------------------------

async function deleteArticleChunks(supabase: ReturnType<typeof createClient>, articleId: string) {
  const { error } = await supabase.rpc('delete_documents_by_slug', { slug: articleId })
  if (error) {
    // Fallback: direct delete
    const { error: directError } = await supabase
      .from('documents')
      .delete()
      .eq('metadata->>article_id', articleId)
    if (directError) throw directError
  }
}

async function insertChunks(
  supabase: ReturnType<typeof createClient>,
  chunks: Chunk[],
  embeddings: number[][],
  enrichedTexts: string[],
) {
  const rows = chunks.map((chunk, i) => ({
    content: enrichedTexts[i],
    metadata: chunk.metadata,
    embedding: embeddings[i],
  }))

  // Insert in batches of 50
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50)
    const { error } = await supabase.from('documents').insert(batch)
    if (error) throw error
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('🔄 RAG Ingestion starting...\n')

  // Check for env vars
  if (!process.env.GOOGLE_API_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('⚠️  Missing env vars (GOOGLE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)')
    console.log('   Skipping RAG ingestion. Set env vars to enable.\n')
    process.exit(0) // Exit gracefully so build continues
  }

  const googleApiKey = requireGoogleApiKey()
  const supabase = getSupabase()
  const anthropic = getAnthropic()

  const hashes = await loadHashes(supabase)
  const newHashes = { ...hashes }

  // Read all chunk files
  if (!existsSync(CHUNKS_DIR)) {
    console.log('⚠️  No chunks directory found. Run rag:export first.')
    process.exit(0)
  }

  const chunkFiles = readdirSync(CHUNKS_DIR).filter(f => f.endsWith('.json'))
  let totalIngested = 0
  let totalSkipped = 0

  for (const file of chunkFiles) {
    const articleId = basename(file, '.json')
    const filePath = resolve(CHUNKS_DIR, file)

    // Check ragReady (skip non-article sources like llms-txt)
    const article = articleRegistry.find(a => a.id === articleId)
    if (article && !article.ragReady) {
      console.log(`  ⏭  ${articleId} — ragReady=false, skipping`)
      totalSkipped++
      continue
    }

    // Read chunks
    const chunks: Chunk[] = JSON.parse(readFileSync(filePath, 'utf-8'))
    if (chunks.length === 0) continue

    // Check hash for changes
    const hash = hashContent(chunks)
    if (hashes[articleId] === hash) {
      console.log(`  ⏭  ${articleId} — no changes (hash: ${hash})`)
      totalSkipped++
      continue
    }

    console.log(`  📝 ${articleId} — ${chunks.length} raw chunks (hash changed: ${hashes[articleId] || 'new'} → ${hash})`)

    // Split large chunks
    const splitChunks = chunks.flatMap(splitChunk)
    console.log(`     → ${splitChunks.length} chunks after splitting`)

    // Contextual retrieval summaries
    const articleTitle = article?.title || articleId
    const enrichedTexts = await addContextualSummaries(splitChunks, articleTitle, anthropic)

    // Embed
    console.log(`     → Embedding ${enrichedTexts.length} chunks...`)
    const embeddings = await embedTexts(enrichedTexts, googleApiKey)

    // Delete old + insert new
    console.log(`     → Upserting to Supabase...`)
    await deleteArticleChunks(supabase, articleId)
    await insertChunks(supabase, splitChunks, embeddings, enrichedTexts)

    newHashes[articleId] = hash
    totalIngested += splitChunks.length
    console.log(`  ✅ ${articleId} — ${splitChunks.length} chunks ingested`)
  }

  // Cleanup: remove articles from Supabase that no longer have chunk files
  const activeArticleIds = new Set(chunkFiles.map(f => basename(f, '.json')))
  for (const articleId of Object.keys(newHashes)) {
    if (!activeArticleIds.has(articleId)) {
      console.log(`  🗑  ${articleId} — removed from index (no chunk file)`)
      await deleteArticleChunks(supabase, articleId)
      delete newHashes[articleId]
    }
  }

  await saveHashes(newHashes, supabase)

  console.log(`\n✅ Ingestion complete: ${totalIngested} ingested, ${totalSkipped} skipped`)
}

main().catch(err => {
  // Runtime errors from third-party services (Gemini quota, Supabase outage,
  // network hiccups) must NOT block the web deploy. Config errors throw early
  // (before main() runs) so by this point we're past validation and any error
  // is operational — log it loudly and exit 0 so the rest of the build
  // pipeline continues. The RAG index will catch up on the next build.
  const status = (err as { status?: number } | null)?.status
  const code = (err as { code?: string } | null)?.code
  console.error('❌ RAG ingestion failed (non-blocking):', err.message)
  if (status) console.error(`   HTTP status: ${status}`)
  if (code) console.error(`   Error code: ${code}`)
  console.error('   Build will continue; RAG index may be stale until next successful ingest.')
  process.exit(0)
})
