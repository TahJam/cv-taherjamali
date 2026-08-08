#!/usr/bin/env npx tsx

/**
 * Sync Prompt to Langfuse — Prompt Versioning
 *
 * Reads chatbot-prompt.txt (source of truth in git) and uploads
 * it to Langfuse as a new versioned prompt with label "production".
 *
 * Smart mode: skips upload if content hasn't changed (compares with latest version).
 *
 * Usage:
 *   npm run prompt:sync          # Smart: only uploads if changed
 *   npm run prompt:sync -- --force  # Force upload even if unchanged
 */

import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

const LANGFUSE_BASE_URL = process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com'
const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY

if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
  // In CI/build environments without Langfuse, skip silently
  console.log('⏭️  prompt:sync skipped (no Langfuse credentials)')
  process.exit(0)
}

const auth = Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString('base64')
const force = process.argv.includes('--force')

async function getLatestPrompt(): Promise<string | null> {
  try {
    const res = await fetch(
      `${LANGFUSE_BASE_URL}/api/public/v2/prompts/chatbot-system?label=production`,
      { headers: { 'Authorization': `Basic ${auth}` } },
    )
    if (!res.ok) return null
    const data = await res.json()
    return data.prompt || null
  } catch {
    return null
  }
}

function hash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
}

async function main() {
  const promptPath = path.join(import.meta.dirname, '..', 'chatbot-prompt.txt')
  const promptContent = fs.readFileSync(promptPath, 'utf-8')
  const localHash = hash(promptContent)

  console.log(`\n📋 Prompt Sync to Langfuse`)
  console.log(`   Source: chatbot-prompt.txt (${promptContent.length} chars, hash: ${localHash})`)

  // Check if content has changed
  if (!force) {
    const remotePrompt = await getLatestPrompt()
    if (remotePrompt && hash(remotePrompt) === localHash) {
      console.log(`   ⏭️  No changes detected — skipping upload`)
      console.log(`   (use --force to upload anyway)\n`)
      return
    }
  }

  // Upload new version
  const response = await fetch(`${LANGFUSE_BASE_URL}/api/public/v2/prompts`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'chatbot-system',
      prompt: promptContent,
      type: 'text',
      labels: ['production'],
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    console.error(`❌ Langfuse API error: ${response.status}`)
    console.error(error)
    process.exit(1)
  }

  const result = await response.json()
  console.log(`   ✅ Uploaded as version ${result.version}`)
  console.log(`   Label: production\n`)
}

main().catch(console.error)
