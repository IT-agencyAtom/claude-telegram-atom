/**
 * Extension config — reads from process.env (loaded by server.ts .env parser).
 * Add keys to ~/.claude/channels/telegram/.env
 */

import { join } from 'path'

export interface ExtConfig {
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  logFile: string | false
  sttApiUrl: string
  sttApiKey: string
  sttModel: string
  sttLanguage: string
  typingIntervalMs: number
  typingTimeoutMs: number
}

let _config: ExtConfig | null = null

export function loadExtConfig(stateDir: string): ExtConfig {
  if (_config) return _config
  _config = {
    logLevel: (process.env.EXT_LOG_LEVEL ?? 'info') as ExtConfig['logLevel'],
    logFile: process.env.EXT_LOG_FILE === 'false' ? false : join(stateDir, 'server.log'),
    sttApiUrl: process.env.STT_API_URL ?? 'https://api.elevenlabs.io/v1/speech-to-text',
    sttApiKey: process.env.STT_API_KEY ?? '',
    sttModel: process.env.STT_MODEL ?? 'scribe_v2',
    sttLanguage: process.env.STT_LANGUAGE ?? '',
    typingIntervalMs: Number(process.env.TYPING_INTERVAL_MS) || 4000,
    typingTimeoutMs: Number(process.env.TYPING_TIMEOUT_MS) || 300_000,
  }
  return _config
}

export function getExtConfig(): ExtConfig {
  if (!_config) throw new Error('loadExtConfig() must be called first')
  return _config
}
