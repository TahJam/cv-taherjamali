// ---------------------------------------------------------------------------
// Real Pino, for the Node contexts in this service:
//   - scripts/dev-server.mjs (local dev adapter)
//   - api/cron/evaluate.js   (the one handler on `runtime: 'nodejs'`)
//
// Edge handlers CANNOT import this — Pino needs Node built-ins that Vercel's
// Edge Runtime doesn't provide. They use ./logger.js, which emits the same
// JSON shape through console. The two expose the same API on purpose, so
// moving a handler between runtimes is an import change and nothing else.
// ---------------------------------------------------------------------------

import pino from 'pino'

// pino-pretty runs as a worker-thread transport. That's fine locally, but on
// Vercel we want plain NDJSON to stdout so the platform's log pipeline (and
// `vercel logs | npx pino-pretty`) handles rendering instead.
const isLocal = !process.env.VERCEL
const level = process.env.LOG_LEVEL || (isLocal ? 'debug' : 'info')

export const logger = pino({
  level,
  // Emit `level: 30` rather than `level: "info"` — matches ./logger.js and is
  // what pino-pretty and most log processors expect.
  formatters: { level: (label, num) => ({ level: num }) },
  // Belt and braces: this repo handles several API keys and a shared secret.
  // Anything logged under these paths is replaced rather than printed.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      'authorization',
      'token',
      'secret',
      'apiKey',
      'api_key',
      'password',
      '*.authorization',
      '*.token',
      '*.secret',
    ],
    censor: '[redacted]',
  },
  ...(isLocal
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : {}),
})

export function createLogger(bindings = {}) {
  return logger.child(bindings)
}
