// Node ESM loader: lets `import x from './file.txt'` work under plain node,
// mimicking what Vite/Vercel's bundler does for chatbot-prompt.txt's raw-text
// import in api/chat.js and api/_shared/prompt.js. Needed because dev-server.mjs
// runs the real handler directly under node, not through a bundler.
import { readFile } from 'node:fs/promises'

export async function load(url, context, nextLoad) {
  if (url.endsWith('.txt')) {
    const source = await readFile(new URL(url), 'utf-8')
    return {
      format: 'module',
      source: `export default ${JSON.stringify(source)};`,
      shortCircuit: true,
    }
  }
  return nextLoad(url, context)
}
