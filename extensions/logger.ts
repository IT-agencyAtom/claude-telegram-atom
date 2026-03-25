/**
 * Structured logger — writes to stderr (MCP convention) + optional log file.
 */

import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { getExtConfig } from './config.js'

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type Level = keyof typeof LEVELS

function write(level: Level, msg: string, data?: Record<string, unknown>): void {
  const cfg = getExtConfig()
  if (LEVELS[level] < LEVELS[cfg.logLevel]) return

  const ts = new Date().toISOString()
  const suffix = data ? ' ' + JSON.stringify(data) : ''
  const line = `${ts} [${level.toUpperCase()}] ${msg}${suffix}\n`

  process.stderr.write(`telegram channel: ${line}`)

  if (cfg.logFile) {
    try {
      mkdirSync(dirname(cfg.logFile), { recursive: true })
      appendFileSync(cfg.logFile, line)
    } catch {}
  }
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => write('debug', msg, data),
  info:  (msg: string, data?: Record<string, unknown>) => write('info', msg, data),
  warn:  (msg: string, data?: Record<string, unknown>) => write('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => write('error', msg, data),
}
