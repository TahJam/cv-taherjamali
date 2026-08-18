#!/usr/bin/env npx tsx

/**
 * Main runner for TJ's eval suite
 *
 * Usage: npm run evals
 */

import * as fs from 'fs'
import * as path from 'path'

// Load .env.local if present (for ANTHROPIC_API_KEY, used by the LLM judge)
const envLocalPath = path.join(import.meta.dirname, '.env.local')
if (fs.existsSync(envLocalPath)) {
  const envContent = fs.readFileSync(envLocalPath, 'utf-8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=')
      const value = valueParts.join('=').replace(/^["']|["']$/g, '')
      if (key && value && !process.env[key]) {
        process.env[key] = value
      }
    }
  }
}
import { runAssertion, type Assertion, type AssertionResult } from './assertions'
import { judgeTone } from './llm-judge'

// Types
interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

interface Test {
  id: string
  description: string
  input: string
  assertions: Assertion[]
  conversation?: ConversationMessage[]
  mode?: 'voice'
}

interface Dataset {
  name: string
  description: string
  tests: Test[]
}

interface RagSource {
  article_id: string
  section_id: string
}

interface ChatResult {
  text: string
  ragSources: RagSource[]
}

interface TestResult {
  testId: string
  description: string
  input: string
  response: string
  ragSources?: RagSource[]
  assertionResults: AssertionResult[]
  passed: boolean
}

interface DatasetResult {
  name: string
  description: string
  results: TestResult[]
  passedCount: number
  totalCount: number
  passRate: number
}

// Config — defaults to the local cv-chat-service dev adapter (scripts/dev-server.mjs, :8787),
// or point CHAT_API_URL at a deployed cv-chat-service URL to test against production.
const CHAT_API_URL = process.env.CHAT_API_URL || 'http://localhost:8787/api/chat'
const RAG_SEARCH_URL = process.env.CHAT_API_URL
  ? process.env.CHAT_API_URL.replace('/api/chat', '/api/rag-search')
  : 'http://localhost:8787/api/rag-search'
const CHAT_SERVICE_SECRET = process.env.CHAT_SERVICE_SECRET
const DATASETS_DIR = path.join(import.meta.dirname, 'datasets')
const RESULTS_DIR = path.join(import.meta.dirname, 'results')

if (!CHAT_SERVICE_SECRET) {
  console.error('❌ Missing CHAT_SERVICE_SECRET env var — cv-chat-service/api/chat.js rejects unauthenticated requests since the Phase 3 service split.')
  process.exit(1)
}

// Console colors
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
}

/**
 * Calls the chat API and returns the full response (buffers the stream)
 */
async function callChat(input: string, conversation?: ConversationMessage[]): Promise<ChatResult> {
  const messages = conversation || [{ role: 'user', content: input }]
  const response = await fetch(CHAT_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHAT_SERVICE_SECRET}`,
      'X-Trace-Source': 'eval',
    },
    body: JSON.stringify({ messages }),
  })

  if (!response.ok) {
    throw new Error(`Chat API error: ${response.status} ${response.statusText}`)
  }

  // Parse the SSE stream
  const reader = response.body?.getReader()
  if (!reader) throw new Error('No reader available')

  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  let ragSources: RagSource[] = []
  let currentEvent = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    let newlineIndex
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)

      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7)
      } else if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        try {
          const data = JSON.parse(line.slice(6))
          if (currentEvent === 'rag-sources' && Array.isArray(data)) {
            ragSources = data
          } else if (data.text) {
            fullText += data.text
          }
        } catch {
          // Skip malformed JSON
        }
        currentEvent = ''
      }
    }
  }

  return { text: fullText, ragSources }
}

/**
 * Calls /api/rag-search for voice-mode tests
 */
async function callVoiceRag(input: string): Promise<ChatResult> {
  const response = await fetch(RAG_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHAT_SERVICE_SECRET}`,
    },
    body: JSON.stringify({
      query: input,
      traceId: 'eval-' + Date.now(),
    }),
  })

  if (!response.ok) {
    throw new Error(`RAG search API error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()
  return { text: data.context || '', ragSources: data.sources || [] }
}

/**
 * Loads all datasets from the directory
 */
function loadDatasets(): Dataset[] {
  const files = fs.readdirSync(DATASETS_DIR).filter((f) => f.endsWith('.json'))
  return files.map((file) => {
    const content = fs.readFileSync(path.join(DATASETS_DIR, file), 'utf-8')
    return JSON.parse(content) as Dataset
  })
}

/**
 * Runs a test's assertions
 */
async function runAssertions(
  response: string,
  assertions: Assertion[],
  ragSources?: RagSource[]
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = []

  for (const assertion of assertions) {
    if (assertion.type === 'llm_judge') {
      // Use the LLM judge for subjective evaluations
      const judgeResult = await judgeTone(response, assertion.criteria as string)
      results.push({
        passed: judgeResult.pass,
        assertion,
        reason: judgeResult.reason,
      })
    } else {
      // Deterministic assertions
      results.push(runAssertion(response, assertion, ragSources))
    }
  }

  return results
}

/**
 * Runs every test in a dataset
 */
async function runDataset(dataset: Dataset): Promise<DatasetResult> {
  console.log(
    `\n${colors.cyan}${colors.bold}📋 ${dataset.name}${colors.reset}`
  )
  console.log(`${colors.dim}   ${dataset.description}${colors.reset}\n`)

  const results: TestResult[] = []

  for (const test of dataset.tests) {
    process.stdout.write(`   ${test.id}: `)

    try {
      // Call the chat API (or the voice RAG endpoint if mode === 'voice')
      const { text: response, ragSources } = test.mode === 'voice'
        ? await callVoiceRag(test.input)
        : await callChat(test.input, test.conversation)

      // Run assertions
      const assertionResults = await runAssertions(response, test.assertions, ragSources)
      const passed = assertionResults.every((r) => r.passed)

      results.push({
        testId: test.id,
        description: test.description,
        input: test.input,
        response,
        ragSources,
        assertionResults,
        passed,
      })

      if (passed) {
        console.log(`${colors.green}✓${colors.reset}`)
      } else {
        console.log(`${colors.red}✗${colors.reset}`)
        // Show failure details
        for (const ar of assertionResults.filter((r) => !r.passed)) {
          console.log(`      ${colors.dim}└─ ${ar.reason}${colors.reset}`)
        }
      }
    } catch (error) {
      console.log(`${colors.red}✗ ERROR${colors.reset}`)
      console.log(
        `      ${colors.dim}└─ ${error instanceof Error ? error.message : 'Unknown error'}${colors.reset}`
      )

      results.push({
        testId: test.id,
        description: test.description,
        input: test.input,
        response: '',
        assertionResults: [],
        passed: false,
      })
    }
  }

  const passedCount = results.filter((r) => r.passed).length
  const totalCount = results.length
  const passRate = Math.round((passedCount / totalCount) * 100)

  return {
    name: dataset.name,
    description: dataset.description,
    results,
    passedCount,
    totalCount,
    passRate,
  }
}

/**
 * Generates the markdown report
 */
function generateReport(datasetResults: DatasetResult[]): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  let totalPassed = 0
  let totalTests = 0

  for (const dr of datasetResults) {
    totalPassed += dr.passedCount
    totalTests += dr.totalCount
  }

  const overallPassRate = Math.round((totalPassed / totalTests) * 100)

  let md = `# Eval Report - ${timestamp}

## Summary

| Metric | Value |
|--------|-------|
| Total Tests | ${totalTests} |
| Passed | ${totalPassed} |
| Failed | ${totalTests - totalPassed} |
| **Pass Rate** | **${overallPassRate}%** |

## Results by Category

| Category | Passed | Total | Rate |
|----------|--------|-------|------|
`

  for (const dr of datasetResults) {
    const emoji = dr.passRate === 100 ? '✅' : dr.passRate >= 80 ? '⚠️' : '❌'
    md += `| ${emoji} ${dr.name} | ${dr.passedCount} | ${dr.totalCount} | ${dr.passRate}% |\n`
  }

  md += `\n## Detailed Results\n`

  for (const dr of datasetResults) {
    md += `\n### ${dr.name}\n\n`
    md += `${dr.description}\n\n`

    for (const result of dr.results) {
      const emoji = result.passed ? '✅' : '❌'
      md += `#### ${emoji} ${result.testId}\n\n`
      md += `**Input:** ${result.input}\n\n`

      if (result.response) {
        md += `**Response:**\n> ${result.response.replace(/\n/g, '\n> ')}\n\n`
      }

      md += `**Assertions:**\n`
      for (const ar of result.assertionResults) {
        const assertEmoji = ar.passed ? '✅' : '❌'
        md += `- ${assertEmoji} ${ar.reason}\n`
      }
      md += '\n'
    }
  }

  return md
}

/**
 * Main
 */
async function main() {
  console.log(`${colors.bold}`)
  console.log(`╔═══════════════════════════════════════════╗`)
  console.log(`║           TJ Chatbot Evals Suite           ║`)
  console.log(`╚═══════════════════════════════════════════╝`)
  console.log(`${colors.reset}`)

  console.log(`${colors.dim}API: ${CHAT_API_URL}${colors.reset}`)

  // Verify the API is reachable
  try {
    const testResponse = await fetch(CHAT_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CHAT_SERVICE_SECRET}`,
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
    })
    if (!testResponse.ok && testResponse.status === 404) {
      throw new Error('API not found')
    }
    if (testResponse.status === 401) {
      throw new Error('Unauthorized — check CHAT_SERVICE_SECRET matches cv-chat-service/.env.local')
    }
  } catch {
    console.log(
      `\n${colors.red}❌ Error: Cannot connect to ${CHAT_API_URL}${colors.reset}`
    )
    console.log(`${colors.dim}   Options:${colors.reset}`)
    console.log(`${colors.dim}   1. Run 'npm run dev --workspace=cv-chat-service' (serves the dev adapter on :8787)${colors.reset}`)
    console.log(`${colors.dim}   2. Test against a deployed cv-chat-service: CHAT_API_URL=https://your-chat-service.vercel.app/api/chat CHAT_SERVICE_SECRET=... npm run evals${colors.reset}`)
    process.exit(1)
  }

  // Load and run datasets
  const datasets = loadDatasets()
  const datasetResults: DatasetResult[] = []

  for (const dataset of datasets) {
    const result = await runDataset(dataset)
    datasetResults.push(result)
  }

  // Summary
  let totalPassed = 0
  let totalTests = 0

  for (const dr of datasetResults) {
    totalPassed += dr.passedCount
    totalTests += dr.totalCount
  }

  const overallPassRate = Math.round((totalPassed / totalTests) * 100)

  console.log(`\n${colors.bold}════════════════════════════════════════════${colors.reset}`)
  console.log(`${colors.bold}  SUMMARY${colors.reset}`)
  console.log(`${colors.bold}════════════════════════════════════════════${colors.reset}\n`)

  for (const dr of datasetResults) {
    const color = dr.passRate === 100 ? colors.green : dr.passRate >= 80 ? colors.yellow : colors.red
    console.log(
      `  ${color}${dr.passRate === 100 ? '✓' : dr.passRate >= 80 ? '⚠' : '✗'}${colors.reset} ${dr.name}: ${dr.passedCount}/${dr.totalCount} (${dr.passRate}%)`
    )
  }

  console.log(`\n  ${colors.bold}Overall: ${totalPassed}/${totalTests} (${overallPassRate}%)${colors.reset}`)

  // Generate report
  const report = generateReport(datasetResults)
  const reportPath = path.join(
    RESULTS_DIR,
    `report-${new Date().toISOString().slice(0, 10)}.md`
  )

  // Asegurar que existe el directorio
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true })
  }

  fs.writeFileSync(reportPath, report)
  console.log(`\n${colors.dim}  Report saved: ${reportPath}${colors.reset}\n`)

  // Exit code basado en resultados
  process.exit(overallPassRate === 100 ? 0 : 1)
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
