/**
 * Speech-to-text via ElevenLabs Scribe API.
 * Endpoint: POST https://api.elevenlabs.io/v1/speech-to-text
 * Auth: xi-api-key header
 * Returns transcription text or null if STT is not configured / fails.
 */

import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getExtConfig } from './config.js'
import { log } from './logger.js'

/**
 * Download voice file from Telegram and transcribe via ElevenLabs STT.
 * @param fileUrl - Full Telegram file download URL
 * @param fileName - Hint for the API (e.g. "voice.ogg")
 */
export async function transcribe(fileUrl: string, fileName = 'voice.ogg'): Promise<string | null> {
  const cfg = getExtConfig()
  if (!cfg.sttApiKey) {
    log.debug('STT not configured (no STT_API_KEY), skipping transcription')
    return null
  }

  const tmpPath = join(tmpdir(), `tg-voice-${Date.now()}.ogg`)

  try {
    // Download from Telegram
    const dlRes = await fetch(fileUrl)
    if (!dlRes.ok) {
      log.error('Failed to download voice from Telegram', { status: dlRes.status })
      return null
    }
    const buf = Buffer.from(await dlRes.arrayBuffer())
    writeFileSync(tmpPath, buf)
    log.debug('Voice downloaded', { size: buf.length, tmpPath })

    // Send to ElevenLabs STT
    const formData = new FormData()
    formData.append('file', Bun.file(tmpPath), fileName)
    formData.append('model_id', cfg.sttModel)
    if (cfg.sttLanguage) formData.append('language_code', cfg.sttLanguage)

    const sttRes = await fetch(cfg.sttApiUrl, {
      method: 'POST',
      headers: { 'xi-api-key': cfg.sttApiKey },
      body: formData,
    })

    if (!sttRes.ok) {
      const body = await sttRes.text().catch(() => '')
      log.error('STT API error', { status: sttRes.status, body: body.slice(0, 200) })
      return null
    }

    const json = (await sttRes.json()) as { text?: string }
    const text = json.text?.trim() ?? null
    log.info('Voice transcribed', { chars: text?.length ?? 0 })
    return text
  } catch (err) {
    log.error('Voice transcription failed', { error: String(err) })
    return null
  } finally {
    try { unlinkSync(tmpPath) } catch {}
  }
}
