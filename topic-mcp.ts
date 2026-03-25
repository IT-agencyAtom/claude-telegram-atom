/**
 * Topic MCP Server — thin relay between Claude Code and the forum router.
 *
 * Spawned by Claude Code as an MCP server (stdio). Connects to the router
 * daemon via unix socket, registers a topic name, and relays messages
 * and tool calls between Claude and the router.
 *
 * Topic name resolution (first match wins):
 *   1. TELEGRAM_TOPIC_NAME env var
 *   2. basename of CLAUDE_CWD env var (project directory)
 *   3. "unnamed-session"
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { connect, type Socket } from 'net'
import { join, basename } from 'path'
import { homedir } from 'os'
import { readFileSync, chmodSync } from 'fs'
import { log, loadExtConfig } from './extensions/index.js'

// ── Config ──────────────────────────────────────────────────────────────────

const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const ENV_FILE = join(STATE_DIR, '.env')
const SOCKET_PATH = join(STATE_DIR, 'router.sock')

// Load .env
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

loadExtConfig(STATE_DIR)

const topicName =
  process.env.TELEGRAM_TOPIC_NAME ??
  (process.env.CLAUDE_CWD ? basename(process.env.CLAUDE_CWD) : null) ??
  'unnamed-session'

log.info('topic-mcp starting', { topic: topicName })

// ── Router connection ───────────────────────────────────────────────────────

let routerSocket: Socket | null = null
let registered = false
let registeredThreadId: number | null = null
let registeredChatId: string | null = null

// Pending tool call promises: request_id → { resolve, reject }
const pendingTools = new Map<string, {
  resolve: (result: Record<string, unknown>) => void
  reject: (err: Error) => void
}>()

let reqCounter = 0
function nextRequestId(): string {
  return `req-${++reqCounter}-${Date.now()}`
}

function sendToRouter(msg: Record<string, unknown>): void {
  if (!routerSocket || routerSocket.destroyed) {
    throw new Error('not connected to router')
  }
  routerSocket.write(JSON.stringify(msg) + '\n')
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'telegram-topic', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
      },
    },
    instructions: [
      'The sender reads Telegram, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat.',
      '',
      'Messages from Telegram arrive as <channel source="telegram" chat_id="..." message_id="..." message_thread_id="..." user="..." ts="...">. Reply with the reply tool — pass chat_id back. The message_thread_id is handled automatically.',
      '',
      'If the tag has an image_path attribute, Read that file — it is a photo the sender attached. If the tag has attachment_file_id, call download_attachment with that file_id to fetch the file, then Read the returned path.',
      '',
      'reply accepts file paths (files: ["/abs/path.png"]) for attachments. Use react to add emoji reactions, and edit_message for interim progress updates.',
      '',
      'When the <channel> meta includes reply_to_message_id and reply_to_text, the sender is replying to a specific earlier bot message. Use that context to understand what they are referring to.',
      '',
      'Multiple users may write in this topic. The user field in the <channel> meta identifies who sent each message.',
      '',
      "Telegram's Bot API exposes no history or search — you only see messages as they arrive.",
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Reply in the Telegram topic. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          text: { type: 'string' },
          reply_to: { type: 'string', description: 'Message ID to thread under.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths to attach.' },
          format: { type: 'string', enum: ['text', 'markdownv2'] },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction to a message.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'string' },
          emoji: { type: 'string' },
        },
        required: ['chat_id', 'message_id', 'emoji'],
      },
    },
    {
      name: 'download_attachment',
      description: 'Download a file attachment from a Telegram message.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'The attachment_file_id from inbound meta' },
        },
        required: ['file_id'],
      },
    },
    {
      name: 'edit_message',
      description: "Edit a message the bot previously sent.",
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'string' },
          text: { type: 'string' },
          format: { type: 'string', enum: ['text', 'markdownv2'] },
        },
        required: ['chat_id', 'message_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  // Auto-inject message_thread_id for topic routing
  const enrichedArgs = {
    ...args,
    ...(registeredThreadId ? { message_thread_id: registeredThreadId } : {}),
  }

  try {
    const requestId = nextRequestId()

    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      pendingTools.set(requestId, { resolve, reject })

      // Timeout after 120s
      setTimeout(() => {
        if (pendingTools.has(requestId)) {
          pendingTools.delete(requestId)
          reject(new Error('tool call timed out'))
        }
      }, 120_000)

      sendToRouter({
        type: 'tool',
        request_id: requestId,
        name: req.params.name,
        args: enrichedArgs,
      })
    })

    return { content: [{ type: 'text', text: result.text as string ?? JSON.stringify(result) }] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }], isError: true }
  }
})

// ── Connect to router ───────────────────────────────────────────────────────

function connectToRouter(): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(SOCKET_PATH)

    let buffer = ''

    socket.on('connect', () => {
      routerSocket = socket
      log.info('connected to router')

      // Register our topic
      sendToRouter({ type: 'register', topic_name: topicName })
    })

    socket.on('data', data => {
      buffer += data.toString()
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        try {
          const msg = JSON.parse(line)
          handleRouterMessage(msg)
          if (msg.type === 'registered') resolve()
          if (msg.type === 'error' && !registered) reject(new Error(msg.error))
        } catch (err) {
          log.error('IPC parse error', { error: String(err) })
        }
      }
    })

    socket.on('close', () => {
      log.warn('router connection closed')
      routerSocket = null
      registered = false
      // Don't crash — Claude Code session should still be able to work locally
    })

    socket.on('error', err => {
      log.error('router connection error', { error: String(err) })
      if (!registered) reject(err)
    })
  })
}

function handleRouterMessage(msg: Record<string, unknown>): void {
  switch (msg.type) {
    case 'registered': {
      registered = true
      registeredThreadId = msg.thread_id as number
      registeredChatId = msg.chat_id as string
      log.info('registered with router', { topic: topicName, thread_id: registeredThreadId })
      break
    }

    case 'message': {
      // Forward to Claude as MCP channel notification
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: msg.content as string,
          meta: msg.meta as Record<string, string>,
        },
      }).catch(err => {
        log.error('failed to deliver to Claude', { error: String(err) })
      })
      break
    }

    case 'tool_result': {
      const requestId = msg.request_id as string
      const pending = pendingTools.get(requestId)
      if (pending) {
        pendingTools.delete(requestId)
        pending.resolve(msg.result as Record<string, unknown>)
      }
      break
    }

    case 'tool_error': {
      const requestId = msg.request_id as string
      const pending = pendingTools.get(requestId)
      if (pending) {
        pendingTools.delete(requestId)
        pending.reject(new Error(msg.error as string))
      }
      break
    }

    case 'error': {
      log.error('router error', { error: msg.error })
      break
    }
  }
}

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  // Connect MCP to Claude Code
  await mcp.connect(new StdioServerTransport())

  // Connect to router with retries
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await connectToRouter()
      log.info('topic-mcp ready', { topic: topicName })
      return
    } catch (err) {
      const delay = Math.min(1000 * attempt, 5000)
      log.warn('router connection failed, retrying', { attempt, delay_s: delay / 1000, error: String(err) })
      await new Promise(r => setTimeout(r, delay))
    }
  }

  log.error('could not connect to router after 10 attempts — running without topic routing')
}

main().catch(err => {
  log.error('topic-mcp startup failed', { error: String(err) })
})

// Shutdown
process.stdin.on('end', () => {
  routerSocket?.destroy()
  process.exit(0)
})
process.stdin.on('close', () => {
  routerSocket?.destroy()
  process.exit(0)
})
