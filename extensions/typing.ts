/**
 * Persistent typing indicator — re-sends "typing" action every N seconds
 * until stopTyping() is called (on reply/edit) or timeout expires.
 */

import { getExtConfig } from './config.js'
import { log } from './logger.js'
import type { Bot } from 'grammy'

const active = new Map<string, { interval: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout> }>()

export function startTyping(bot: Bot, chatId: string): void {
  stopTyping(chatId)

  const cfg = getExtConfig()
  const send = () => void bot.api.sendChatAction(chatId, 'typing').catch(() => {})

  send() // immediately

  const interval = setInterval(send, cfg.typingIntervalMs)
  const timeout = setTimeout(() => stopTyping(chatId), cfg.typingTimeoutMs)

  active.set(chatId, { interval, timeout })
  log.debug('typing started', { chatId })
}

export function stopTyping(chatId: string): void {
  const entry = active.get(chatId)
  if (!entry) return
  clearInterval(entry.interval)
  clearTimeout(entry.timeout)
  active.delete(chatId)
  log.debug('typing stopped', { chatId })
}
