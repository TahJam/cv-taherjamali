/**
 * Export content into normalized JSON chunks for RAG indexing.
 *
 * Supports multiple input formats via pluggable parsers:
 *   - i18n TypeScript objects (case-study articles, once written)
 *   - Markdown (llms.txt today; any future markdown source)
 *
 * Output: scripts/chunks/{source}.json
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.app.json scripts/export-chunks.ts
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { articleRegistry } from '../src/articles/registry.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const CHUNKS_DIR = resolve(root, 'scripts/chunks')

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
// Keys to EXCLUDE when traversing i18n objects (metadata, navigation, images)
// ---------------------------------------------------------------------------

const EXCLUDE_KEYS = new Set([
  'slug', 'altSlug', 'readingTime', 'date', 'badge', 'seo', 'nav',
  'breadcrumbHome', 'breadcrumbCurrent', 'back',
  'href', 'icon', 'src', 'imgAlt', 'imgTitle', 'image', 'ogImage',
  'kickerLink', 'figcaption', 'importUrl', 'downloadUrl', 'jsonUrl',
  'num', 'emoji', 'kind', 'value',  // metric values, step numbers
  'internalLinks',
])

// ---------------------------------------------------------------------------
// HTML stripping
// ---------------------------------------------------------------------------

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, '').trim()
}

// ---------------------------------------------------------------------------
// Recursive text extraction from nested i18n objects
// ---------------------------------------------------------------------------

function extractText(obj: unknown, depth = 0): string {
  if (depth > 10) return '' // safety guard

  if (typeof obj === 'string') {
    return stripHtml(obj)
  }

  if (Array.isArray(obj)) {
    return obj.map(item => extractText(item, depth + 1)).filter(Boolean).join('\n')
  }

  if (typeof obj === 'object' && obj !== null) {
    const parts: string[] = []
    for (const [key, value] of Object.entries(obj)) {
      if (EXCLUDE_KEYS.has(key)) continue
      const text = extractText(value, depth + 1)
      if (text) parts.push(text)
    }
    return parts.join('\n')
  }

  return ''
}

// ---------------------------------------------------------------------------
// Parser 1: i18n TypeScript objects (case-study articles)
// ---------------------------------------------------------------------------

interface I18nSource {
  articleId: string
  content: Record<string, unknown>
  sourceFile: string
}

async function loadI18nSources(): Promise<I18nSource[]> {
  const sources: I18nSource[] = []

  for (const article of articleRegistry) {
    if (!article.ragReady || !article.i18nFile) continue

    const modulePath = resolve(root, article.i18nFile)
    try {
      const mod = await import(modulePath)
      // Find the *Content export that is an object (e.g. jacoboContent, chatbotContent)
      const contentKey = Object.keys(mod).find(k => k.endsWith('Content') && typeof mod[k] === 'object' && mod[k] !== null)
      if (!contentKey) {
        console.warn(`  ⚠ ${article.id}: no *Content export found in ${article.i18nFile}, skipping`)
        continue
      }
      sources.push({
        articleId: article.id,
        content: mod[contentKey] as Record<string, unknown>,
        sourceFile: article.i18nFile,
      })
    } catch (err) {
      console.warn(`  ⚠ ${article.id}: failed to import ${article.i18nFile} — ${err}`)
    }
  }

  return sources
}

function parseI18n(source: I18nSource): Chunk[] {
  const article = articleRegistry.find(a => a.id === source.articleId)
  if (!article) {
    console.warn(`  ⚠ Article ${source.articleId} not found in registry, skipping`)
    return []
  }

  const content = source.content as Record<string, unknown>

  const baseMetadata: Omit<ChunkMetadata, 'section_id' | 'section_anchor'> = {
    article_id: source.articleId,
    article_slug: `/${article.slug}`,
    page_path: `/${article.slug}`,
    source_file: source.sourceFile,
    format: 'i18n',
  }

  const chunks: Chunk[] = []

  // Build anchor lookup from registry sectionLabels (source of truth for HTML IDs)
  const registryAnchors = new Set(Object.keys(article.sectionLabels))

  // Helper: resolve the correct HTML anchor for a given i18n key
  const resolveAnchor = (key: string): string => {
    // Direct match in registry (most sections)
    if (registryAnchors.has(key)) return `#${key}`
    // camelCase → kebab-case fallback (e.g. timeSinks → time-sinks)
    const kebab = key.replace(/([A-Z])/g, '-$1').replace(/(\d+)/g, '-$1').toLowerCase().replace(/^-/, '')
    if (registryAnchors.has(kebab)) return `#${kebab}`
    return ''
  }

  // Extract header + intro as a single "intro" chunk
  const introText = [
    extractText(content.header),
    extractText(content.intro),
    typeof content.tldr === 'string' ? stripHtml(content.tldr) : extractText(content.tldr),
  ].filter(Boolean).join('\n')

  if (introText.trim()) {
    chunks.push({
      content: introText.trim(),
      metadata: { ...baseMetadata, section_id: 'intro', section_anchor: '' },
    })
  }

  // Extract heroMetrics
  if (content.heroMetrics) {
    const metricsText = extractText(content.heroMetrics)
    if (metricsText.trim()) {
      chunks.push({
        content: metricsText.trim(),
        metadata: { ...baseMetadata, section_id: 'metrics', section_anchor: '' },
      })
    }
  }

  // Extract each section (nested under content.sections) — only if it has a real page anchor
  const sections = content.sections as Record<string, unknown> | undefined
  if (sections && typeof sections === 'object') {
    for (const [sectionKey, sectionValue] of Object.entries(sections)) {
      const anchor = resolveAnchor(sectionKey)
      if (!anchor) continue // skip sections without a navigable anchor
      const text = extractText(sectionValue)
      if (!text.trim()) continue

      chunks.push({
        content: text.trim(),
        metadata: {
          ...baseMetadata,
          section_id: sectionKey,
          section_anchor: anchor,
        },
      })
    }
  }

  // Extract top-level content keys — only those with a real page anchor
  const skipKeys = new Set(['header', 'intro', 'tldr', 'heroMetrics', 'sections'])
  for (const [key, value] of Object.entries(content)) {
    if (skipKeys.has(key)) continue
    if (sections && key in sections) continue
    const anchor = resolveAnchor(key)
    if (!anchor) continue // skip metadata keys (slug, seo, footer, etc.)
    const text = extractText(value)
    if (!text.trim()) continue
    chunks.push({
      content: text.trim(),
      metadata: {
        ...baseMetadata,
        section_id: key,
        section_anchor: anchor,
      },
    })
  }

  return chunks
}

// ---------------------------------------------------------------------------
// Parser 2: Markdown (llms.txt today; any future markdown source)
// ---------------------------------------------------------------------------

/**
 * Maps a markdown ## section heading (kebab-cased) to the real HTML anchor on
 * the homepage it corresponds to, so RAG source badges link somewhere real.
 * See src/App.tsx for the actual section ids. Sections with no direct
 * homepage counterpart (summary, featured-project) fall back to the closest
 * relevant section rather than a dead anchor.
 */
const LLMS_TXT_SECTION_ANCHORS: Record<string, string> = {
  'current-role': '#experience',
  'prior-experience': '#experience',
  'featured-project': '#projects',
  'skills': '#tech',
  'education': '#education',
  'contact': '#contact',
}

function parseMarkdown(content: string, articleId: string, sourceFile: string, anchorMap: Record<string, string> = {}): Chunk[] {
  // Strip frontmatter
  const body = content.replace(/^---[\s\S]*?---\n/, '')

  const chunks: Chunk[] = []
  let currentH2 = 'general'
  let currentH3 = ''
  let currentText = ''

  const flush = () => {
    if (!currentText.trim()) return
    const sectionId = currentH3 || currentH2
    chunks.push({
      content: currentText.trim(),
      metadata: {
        article_id: articleId,
        article_slug: '/',
        section_id: sectionId,
        section_anchor: anchorMap[sectionId] || '',
        page_path: '/',
        source_file: sourceFile,
        format: 'markdown',
      },
    })
  }

  for (const line of body.split('\n')) {
    const h2Match = line.match(/^##\s+(.+)/)
    const h3Match = line.match(/^###\s+(.+)/)

    if (h2Match || h3Match) {
      flush()
      currentText = ''

      if (h2Match) {
        currentH2 = h2Match[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        currentH3 = ''
      } else if (h3Match) {
        currentH3 = h3Match[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      }
    }

    currentText += line + '\n'
  }

  flush()

  return chunks
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('📦 Exporting content chunks for RAG...\n')

  mkdirSync(CHUNKS_DIR, { recursive: true })

  let totalChunks = 0

  // Source 1: llms.txt (bootstrapped content — no case-study articles exist
  // yet, per docs/plans/phase-2-chatbot-rag.md's staged content decision)
  const llmsTxtPath = resolve(root, 'public/llms.txt')
  const llmsTxtContent = readFileSync(llmsTxtPath, 'utf-8')
  const llmsChunks = parseMarkdown(llmsTxtContent, 'home', 'public/llms.txt', LLMS_TXT_SECTION_ANCHORS)
  if (llmsChunks.length > 0) {
    writeFileSync(resolve(CHUNKS_DIR, 'home.json'), JSON.stringify(llmsChunks, null, 2))
    console.log(`  ✓ home (llms.txt) → ${llmsChunks.length} chunks`)
    totalChunks += llmsChunks.length
  }

  // Source 2: i18n case-study articles (none yet — populated as they're written)
  const i18nSources = await loadI18nSources()
  for (const source of i18nSources) {
    const article = articleRegistry.find(a => a.id === source.articleId)!

    const chunks = parseI18n(source)
    if (chunks.length === 0) continue

    // Validate: every non-empty section_anchor must exist in registry sectionLabels
    const validAnchors = new Set(Object.keys(article.sectionLabels))
    for (const chunk of chunks) {
      const anchor = chunk.metadata.section_anchor
      if (anchor) {
        const anchorId = anchor.replace(/^#/, '')
        if (!validAnchors.has(anchorId)) {
          console.warn(`  ⚠ ${source.articleId}: anchor "${anchor}" (section: ${chunk.metadata.section_id}) not in registry — badge will link to broken hash`)
        }
      }
    }

    const outPath = resolve(CHUNKS_DIR, `${source.articleId}.json`)
    writeFileSync(outPath, JSON.stringify(chunks, null, 2))
    console.log(`  ✓ ${source.articleId} → ${chunks.length} chunks`)
    totalChunks += chunks.length
  }

  console.log(`\n✅ Total: ${totalChunks} chunks exported to scripts/chunks/`)
}

main()
