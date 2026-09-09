// ---------------------------------------------------------------------------
// Edge-safe structured logger with a Pino-compatible API.
//
// WHY THIS EXISTS: every function in cv-ui/api/ declares `runtime: 'edge'`.
// Vercel's Edge Runtime is a limited V8 isolate with no Node built-ins, and
// Pino depends on them (sonic-boom, worker threads, process.stdout) — so
// `import pino` throws there.
//
// WHY IT'S DUPLICATED: cv-chat-service has a byte-identical copy. cv-ui is a
// separately deployed Vercel project and, by the Phase 3 architecture rule,
// never imports anything from cv-chat-service/ — see
// docs/adr/002-chat-service-isolation.md. A shared package would couple the two
// deployments for ~90 lines. If you change one, change the other.
//
// Emits the same newline-delimited JSON shape Pino does, so
// `vercel logs ... | npx pino-pretty` renders it and log processors that
// understand Pino understand this.
// ---------------------------------------------------------------------------

// Pino's numeric levels. Kept identical so output is interchangeable.
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }

const DEFAULT_LEVEL = process.env.LOG_LEVEL || 'info'

// Edge has console.{log,warn,error}; map so Vercel routes severity correctly.
function sink(levelValue) {
  if (levelValue >= LEVELS.error) return console.error
  if (levelValue >= LEVELS.warn) return console.warn
  return console.log
}

// Mirrors Pino's default `err` serializer.
function serializeError(err) {
  if (!(err instanceof Error)) return err
  return {
    type: err.name,
    message: err.message,
    stack: err.stack,
    ...(err.cause ? { cause: String(err.cause) } : {}),
  }
}

function normalize(bindings) {
  if (!bindings || typeof bindings !== 'object') return {}
  const out = { ...bindings }
  if (out.err) out.err = serializeError(out.err)
  if (out.error && out.error instanceof Error) out.error = serializeError(out.error)
  return out
}

function make(bindings = {}, level = DEFAULT_LEVEL) {
  const threshold = LEVELS[level] ?? LEVELS.info

  function emit(levelName, a, b) {
    const value = LEVELS[levelName]
    if (value < threshold) return

    // Pino's signature: log(msg) | log(mergingObject, msg)
    let fields = {}
    let msg
    if (typeof a === 'string') {
      msg = a
    } else {
      fields = normalize(a)
      msg = b
    }

    const line = { level: value, time: Date.now(), ...bindings, ...fields }
    if (msg !== undefined) line.msg = msg

    try {
      sink(value)(JSON.stringify(line))
    } catch {
      // Never let logging take down a request (circular refs, etc.)
      sink(value)(JSON.stringify({ level: value, time: Date.now(), msg: String(msg ?? '') }))
    }
  }

  const logger = {
    level,
    child: (extra) => make({ ...bindings, ...normalize(extra) }, level),
  }
  for (const name of Object.keys(LEVELS)) {
    logger[name] = (a, b) => emit(name, a, b)
  }
  return logger
}

export const logger = make()
export const createLogger = make
