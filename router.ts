#!/usr/bin/env bun
/**
 * Telegram Forum Router
 *
 * Standalone daemon that polls Telegram and routes forum topic messages
 * to registered Claude Code sessions via unix socket IPC.
 *
 * Each Claude Code session registers with a topic name. If the topic
 * doesn't exist in the forum, the router creates it automatically.
 *
 * Usage:
 *   bun router.ts
 *
 * Requires in ~/.claude/channels/telegram/.env:
 *   TELEGRAM_BOT_TOKEN=...
 *   TELEGRAM_FORUM_CHAT_ID=...  (set after adding bot to the forum group)
 */

import { Bot, GrammyError, InputFile } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { createServer, type Socket } from 'net'
import {
  readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync,
  statSync, realpathSync, rmSync, chmodSync,
} from 'fs'
import { homedir, tmpdir } from 'os'
import { join, extname, sep } from 'path'
import { loadExtConfig, log } from './extensions/index.js'
import { transcribe } from './extensions/stt.js'

// ── Config ──────────────────────────────────────────────────────────────────

const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const ENV_FILE = join(STATE_DIR, '.env')
const SOCKET_PATH = join(STATE_DIR, 'router.sock')
const TOPICS_FILE = join(STATE_DIR, 'topics.json')
const PID_FILE = join(STATE_DIR, 'router.pid')
const SESSIONS_FILE = join(STATE_DIR, 'sessions.json')
const INBOX_DIR = join(STATE_DIR, 'inbox')

// Load .env (same logic as server.ts)
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(
    `router: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n`,
  )
  process.exit(1)
}

loadExtConfig(STATE_DIR)

// ── PID lock — kill previous router ─────────────────────────────────────────

try {
  const oldPid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10)
  if (oldPid && oldPid !== process.pid) {
    try {
      process.kill(oldPid, 'SIGTERM')
      log.info('killed previous router', { pid: oldPid })
    } catch {}
  }
} catch {}
mkdirSync(STATE_DIR, { recursive: true })
writeFileSync(PID_FILE, String(process.pid))

// ── Topics persistence ──────────────────────────────────────────────────────

type TopicsMap = Record<string, { thread_id: number; created_at: string }>

interface TopicsConfig {
  chat_id: string
  topics: TopicsMap
}

function loadTopics(): TopicsConfig {
  try {
    return JSON.parse(readFileSync(TOPICS_FILE, 'utf8'))
  } catch {
    return { chat_id: '', topics: {} }
  }
}

function saveTopics(cfg: TopicsConfig): void {
  writeFileSync(TOPICS_FILE, JSON.stringify(cfg, null, 2) + '\n')
}

let topicsConfig = loadTopics()
const forumChatId = process.env.TELEGRAM_FORUM_CHAT_ID ?? topicsConfig.chat_id

// ── Sessions registry (for restore) ────────────────────────────────────────

interface SessionEntry {
  topic_name: string
  cwd: string
  launch_cmd: string
  last_seen: string
}

type SessionsRegistry = Record<string, SessionEntry>  // keyed by topic_name

function loadSessions(): SessionsRegistry {
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveSessions(reg: SessionsRegistry): void {
  writeFileSync(SESSIONS_FILE, JSON.stringify(reg, null, 2) + '\n')
}

const sessionsRegistry = loadSessions()

if (!forumChatId) {
  log.info('TELEGRAM_FORUM_CHAT_ID not set — router will detect it from the first forum message')
}

// ── Bot ─────────────────────────────────────────────────────────────────────

const bot = new Bot(TOKEN)
let botUsername = ''

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

// ── Connected MCP clients ───────────────────────────────────────────────────

interface Client {
  socket: Socket
  topicName: string
  threadId: number
  chatId: string
}

// topicName → Client
const clients = new Map<string, Client>()
// threadId → topicName (reverse lookup for routing)
const threadToTopic = new Map<number, string>()

function send(socket: Socket, msg: Record<string, unknown>): void {
  socket.write(JSON.stringify(msg) + '\n')
}

// ── Typing management ───────────────────────────────────────────────────────

const typingIntervals = new Map<number, ReturnType<typeof setInterval>>()

function startTopicTyping(chatId: string, threadId: number): void {
  stopTopicTyping(threadId)
  const doType = () => void bot.api.sendChatAction(chatId, 'typing', { message_thread_id: threadId }).catch(() => {})
  doType()
  typingIntervals.set(threadId, setInterval(doType, 4000))
  setTimeout(() => stopTopicTyping(threadId), 300_000)
}

function stopTopicTyping(threadId: number): void {
  const iv = typingIntervals.get(threadId)
  if (iv) { clearInterval(iv); typingIntervals.delete(threadId) }
}

// ── IPC Server (unix socket) ────────────────────────────────────────────────

// Clean up stale socket
try { unlinkSync(SOCKET_PATH) } catch {}

const ipcServer = createServer(socket => {
  let buffer = ''
  let clientTopicName = ''

  socket.on('data', data => {
    buffer += data.toString()
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      try {
        const msg = JSON.parse(line)
        void handleClientMessage(socket, msg).then(name => {
          if (name) clientTopicName = name
        })
      } catch (err) {
        log.error('IPC parse error', { error: String(err) })
      }
    }
  })

  socket.on('close', () => {
    if (clientTopicName) {
      const client = clients.get(clientTopicName)
      if (client) {
        threadToTopic.delete(client.threadId)
        clients.delete(clientTopicName)
        log.info('client disconnected', { topic: clientTopicName })
      }
    }
  })

  socket.on('error', () => {})
})

async function handleClientMessage(socket: Socket, msg: Record<string, unknown>): Promise<string | null> {
  switch (msg.type) {
    case 'register': {
      const topicName = msg.topic_name as string
      if (!topicName) {
        send(socket, { type: 'error', error: 'topic_name required' })
        return null
      }

      const chatId = forumChatId ?? topicsConfig.chat_id
      if (!chatId) {
        send(socket, { type: 'error', error: 'TELEGRAM_FORUM_CHAT_ID not configured and not yet detected' })
        return null
      }

      let threadId = topicsConfig.topics[topicName]?.thread_id

      if (!threadId) {
        // Create new forum topic
        try {
          const result = await bot.api.createForumTopic(chatId, topicName)
          threadId = result.message_thread_id
          topicsConfig.topics[topicName] = {
            thread_id: threadId,
            created_at: new Date().toISOString(),
          }
          topicsConfig.chat_id = chatId
          saveTopics(topicsConfig)
          log.info('created forum topic', { name: topicName, thread_id: threadId })
        } catch (err) {
          send(socket, { type: 'error', error: `failed to create topic: ${err}` })
          return null
        }
      }

      clients.set(topicName, { socket, topicName, threadId, chatId })
      threadToTopic.set(threadId, topicName)

      // Save session for restore
      const cwd = (msg.cwd as string) || ''
      if (cwd) {
        // Build the launch command that can reproduce this session
        const launchCmd = `TELEGRAM_TOPIC_NAME="${topicName}" claude --dangerously-load-development-channels plugin:telegram-enhanced@atom-plugins`
        sessionsRegistry[topicName] = {
          topic_name: topicName,
          cwd,
          launch_cmd: launchCmd,
          last_seen: new Date().toISOString(),
        }
        saveSessions(sessionsRegistry)
      }

      send(socket, {
        type: 'registered',
        topic_name: topicName,
        thread_id: threadId,
        chat_id: chatId,
      })

      log.info('client registered', { topic: topicName, thread_id: threadId })

      // Send welcome message to the topic
      await bot.api.sendMessage(chatId, `Session connected.`, {
        message_thread_id: threadId,
      }).catch(() => {})

      return topicName
    }

    case 'tool': {
      const requestId = msg.request_id as string
      const toolName = msg.name as string
      const args = msg.args as Record<string, unknown>

      try {
        const result = await executeTool(toolName, args)
        send(socket, { type: 'tool_result', request_id: requestId, result })
      } catch (err) {
        send(socket, { type: 'tool_error', request_id: requestId, error: String(err) })
      }
      return null
    }

    case 'typing_stop': {
      const threadId = msg.thread_id as number
      if (threadId) stopTopicTyping(threadId)
      return null
    }

    default:
      return null
  }
}

// ── Tool execution (proxied from MCP clients) ──────────────────────────────

async function executeTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (name) {
    case 'reply': {
      const chatId = args.chat_id as string
      const text = args.text as string
      const threadId = args.message_thread_id ? Number(args.message_thread_id) : undefined
      const replyTo = args.reply_to != null ? Number(args.reply_to) : undefined
      const files = (args.files as string[] | undefined) ?? []
      const format = (args.format as string | undefined) ?? 'text'
      const parseMode = format === 'markdownv2' ? 'MarkdownV2' as const : undefined

      if (threadId) stopTopicTyping(threadId)

      // Chunk long messages
      const limit = 4096
      const chunks = text.length <= limit ? [text] : chunkText(text, limit)
      const sentIds: number[] = []

      for (let i = 0; i < chunks.length; i++) {
        const shouldReplyTo = replyTo != null && i === 0
        const sent = await bot.api.sendMessage(chatId, chunks[i], {
          ...(threadId ? { message_thread_id: threadId } : {}),
          ...(shouldReplyTo ? { reply_parameters: { message_id: replyTo } } : {}),
          ...(parseMode ? { parse_mode: parseMode } : {}),
        })
        sentIds.push(sent.message_id)
      }

      for (const f of files) {
        const ext = extname(f).toLowerCase()
        const input = new InputFile(f)
        const opts = {
          ...(threadId ? { message_thread_id: threadId } : {}),
          ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
        }
        if (PHOTO_EXTS.has(ext)) {
          const sent = await bot.api.sendPhoto(chatId, input, opts)
          sentIds.push(sent.message_id)
        } else {
          const sent = await bot.api.sendDocument(chatId, input, opts)
          sentIds.push(sent.message_id)
        }
      }

      return { text: sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})` }
    }

    case 'react': {
      await bot.api.setMessageReaction(args.chat_id as string, Number(args.message_id), [
        { type: 'emoji', emoji: args.emoji as ReactionTypeEmoji['emoji'] },
      ])
      return { text: 'reacted' }
    }

    case 'edit_message': {
      const threadId = args.message_thread_id ? Number(args.message_thread_id) : undefined
      if (threadId) stopTopicTyping(threadId)
      const editFormat = (args.format as string | undefined) ?? 'text'
      const editParseMode = editFormat === 'markdownv2' ? 'MarkdownV2' as const : undefined
      const edited = await bot.api.editMessageText(
        args.chat_id as string,
        Number(args.message_id),
        args.text as string,
        ...(editParseMode ? [{ parse_mode: editParseMode }] : []),
      )
      const id = typeof edited === 'object' ? edited.message_id : args.message_id
      return { text: `edited (id: ${id})` }
    }

    case 'download_attachment': {
      const fileId = args.file_id as string
      const file = await bot.api.getFile(fileId)
      if (!file.file_path) throw new Error('Telegram returned no file_path')
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
      const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
      const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
      const path = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return { text: path }
    }

    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

function chunkText(text: string, limit: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ── Inbound message routing ─────────────────────────────────────────────────

function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

async function routeMessage(
  threadId: number,
  chatId: string,
  messageId: number,
  from: { id: number; username?: string },
  date: number,
  text: string,
  imagePath?: string,
  attachment?: { kind: string; file_id: string; size?: number; mime?: string; name?: string },
  replyToMessageId?: number,
  replyToText?: string,
): Promise<void> {
  const topicName = threadToTopic.get(threadId)
  if (!topicName) {
    log.debug('no client for thread', { thread_id: threadId })
    return
  }

  const client = clients.get(topicName)
  if (!client) return

  startTopicTyping(chatId, threadId)

  const meta: Record<string, string> = {
    chat_id: chatId,
    message_id: String(messageId),
    message_thread_id: String(threadId),
    user: from.username ?? String(from.id),
    user_id: String(from.id),
    ts: new Date(date * 1000).toISOString(),
  }
  if (imagePath) meta.image_path = imagePath
  if (attachment) {
    meta.attachment_kind = attachment.kind
    meta.attachment_file_id = attachment.file_id
    if (attachment.size != null) meta.attachment_size = String(attachment.size)
    if (attachment.mime) meta.attachment_mime = attachment.mime
    if (attachment.name) meta.attachment_name = attachment.name
  }
  if (replyToMessageId) meta.reply_to_message_id = String(replyToMessageId)
  if (replyToText) meta.reply_to_text = replyToText

  send(client.socket, { type: 'message', content: text, meta })
  log.info('routed message', { topic: topicName, user: from.username ?? from.id, thread_id: threadId })
}

// ── Bot message handlers ────────────────────────────────────────────────────

// Auto-detect forum chat ID
bot.on('message', async (ctx, next) => {
  if (!topicsConfig.chat_id && (ctx.chat?.type === 'supergroup') && ctx.message?.is_topic_message) {
    topicsConfig.chat_id = String(ctx.chat.id)
    saveTopics(topicsConfig)
    log.info('auto-detected forum chat', { chat_id: topicsConfig.chat_id })
  }
  await next()
})

bot.on('message:text', async ctx => {
  if (!ctx.message?.message_thread_id) return
  if (ctx.from?.id === ctx.me.id) return

  const replyTo = ctx.message.reply_to_message
  await routeMessage(
    ctx.message.message_thread_id,
    String(ctx.chat.id),
    ctx.message.message_id,
    ctx.from!,
    ctx.message.date,
    ctx.message.text,
    undefined,
    undefined,
    replyTo?.message_id,
    replyTo && 'text' in replyTo ? replyTo.text : undefined,
  )
})

bot.on('message:photo', async ctx => {
  if (!ctx.message?.message_thread_id) return
  if (ctx.from?.id === ctx.me.id) return

  const caption = ctx.message.caption ?? '(photo)'
  let imagePath: string | undefined

  try {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    const file = await ctx.api.getFile(best.file_id)
    if (file.file_path) {
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = file.file_path.split('.').pop() ?? 'jpg'
      imagePath = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(imagePath, buf)
    }
  } catch (err) {
    log.error('photo download failed', { error: String(err) })
  }

  const replyTo = ctx.message.reply_to_message
  await routeMessage(
    ctx.message.message_thread_id,
    String(ctx.chat.id),
    ctx.message.message_id,
    ctx.from!,
    ctx.message.date,
    caption,
    imagePath,
    undefined,
    replyTo?.message_id,
    replyTo && 'text' in replyTo ? replyTo.text : undefined,
  )
})

bot.on('message:voice', async ctx => {
  if (!ctx.message?.message_thread_id) return
  if (ctx.from?.id === ctx.me.id) return

  const voice = ctx.message.voice
  let text = ctx.message.caption ?? '(voice message)'

  // STT transcription
  try {
    const file = await ctx.api.getFile(voice.file_id)
    if (file.file_path) {
      const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const transcription = await transcribe(fileUrl, 'voice.ogg')
      if (transcription) text = `[voice] ${transcription}`
    }
  } catch (err) {
    log.error('voice STT failed', { error: String(err) })
  }

  const replyTo = ctx.message.reply_to_message
  await routeMessage(
    ctx.message.message_thread_id,
    String(ctx.chat.id),
    ctx.message.message_id,
    ctx.from!,
    ctx.message.date,
    text,
    undefined,
    { kind: 'voice', file_id: voice.file_id, size: voice.file_size, mime: voice.mime_type },
    replyTo?.message_id,
    replyTo && 'text' in replyTo ? replyTo.text : undefined,
  )
})

bot.on('message:document', async ctx => {
  if (!ctx.message?.message_thread_id) return
  if (ctx.from?.id === ctx.me.id) return

  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  const text = ctx.message.caption ?? `(document: ${name ?? 'file'})`

  const replyTo = ctx.message.reply_to_message
  await routeMessage(
    ctx.message.message_thread_id,
    String(ctx.chat.id),
    ctx.message.message_id,
    ctx.from!,
    ctx.message.date,
    text,
    undefined,
    { kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name },
    replyTo?.message_id,
    replyTo && 'text' in replyTo ? replyTo.text : undefined,
  )
})

bot.on('message:audio', async ctx => {
  if (!ctx.message?.message_thread_id) return
  if (ctx.from?.id === ctx.me.id) return

  const audio = ctx.message.audio
  const name = safeName(audio.file_name)
  const text = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`

  const replyTo = ctx.message.reply_to_message
  await routeMessage(
    ctx.message.message_thread_id,
    String(ctx.chat.id),
    ctx.message.message_id,
    ctx.from!,
    ctx.message.date,
    text,
    undefined,
    { kind: 'audio', file_id: audio.file_id, size: audio.file_size, mime: audio.mime_type, name },
    replyTo?.message_id,
    replyTo && 'text' in replyTo ? replyTo.text : undefined,
  )
})

bot.on('message:video', async ctx => {
  if (!ctx.message?.message_thread_id) return
  if (ctx.from?.id === ctx.me.id) return

  const video = ctx.message.video
  const text = ctx.message.caption ?? '(video)'

  const replyTo = ctx.message.reply_to_message
  await routeMessage(
    ctx.message.message_thread_id,
    String(ctx.chat.id),
    ctx.message.message_id,
    ctx.from!,
    ctx.message.date,
    text,
    undefined,
    { kind: 'video', file_id: video.file_id, size: video.file_size, mime: video.mime_type, name: safeName(video.file_name) },
    replyTo?.message_id,
    replyTo && 'text' in replyTo ? replyTo.text : undefined,
  )
})

bot.on('message:sticker', async ctx => {
  if (!ctx.message?.message_thread_id) return
  if (ctx.from?.id === ctx.me.id) return

  const sticker = ctx.message.sticker
  const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''

  await routeMessage(
    ctx.message.message_thread_id,
    String(ctx.chat.id),
    ctx.message.message_id,
    ctx.from!,
    ctx.message.date,
    `(sticker${emoji})`,
    undefined,
    { kind: 'sticker', file_id: sticker.file_id, size: sticker.file_size },
  )
})

bot.on('message:video_note', async ctx => {
  if (!ctx.message?.message_thread_id) return
  if (ctx.from?.id === ctx.me.id) return

  const vn = ctx.message.video_note
  await routeMessage(
    ctx.message.message_thread_id,
    String(ctx.chat.id),
    ctx.message.message_id,
    ctx.from!,
    ctx.message.date,
    '(video note)',
    undefined,
    { kind: 'video_note', file_id: vn.file_id, size: vn.file_size },
  )
})

bot.catch(err => {
  log.error('bot handler error', { error: String(err.error) })
})

// ── Shutdown ────────────────────────────────────────────────────────────────

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  log.info('router shutting down')
  try { rmSync(PID_FILE, { force: true }) } catch {}
  try { unlinkSync(SOCKET_PATH) } catch {}
  ipcServer.close()
  for (const [, client] of clients) client.socket.destroy()
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ── Start ───────────────────────────────────────────────────────────────────

ipcServer.listen(SOCKET_PATH, () => {
  log.info('IPC server listening', { socket: SOCKET_PATH })
})

void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => {
          botUsername = info.username
          log.info('router polling', { username: info.username, forum_chat_id: forumChatId || '(auto-detect)' })
        },
      })
      return
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 409) {
        const delay = Math.min(1000 * attempt, 15000)
        log.warn('409 Conflict, retrying', { attempt, delay_s: delay / 1000 })
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      if (err instanceof Error && err.message === 'Aborted delay') return
      log.error('polling failed', { error: String(err) })
      return
    }
  }
})()
