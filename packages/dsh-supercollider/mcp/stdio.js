/**
 * dsh-supercollider — the MCP face: the same engine, over stdio.
 *
 * The pack ships zero npm dependencies, so this is JSON-RPC 2.0 by hand: read
 * one JSON object per line from stdin, write one per line to stdout, and answer
 * `initialize`, `tools/list` and `tools/call`. That is the whole protocol a tool
 * server needs, and it is small enough that writing it is cheaper than owning a
 * dependency — which is the same trade the OSC codec makes.
 *
 * Why it exists at all: the DSH plugin is the first-class target, but the SAME
 * engine (install discovery, the live `sclang` session, the OSC client, the
 * `.schelp` index, the example library) is what an MCP client wants. Claude Code
 * and Codex can have the eleven tools without a second implementation and without
 * the harness.
 *
 *     node plugin/mcp/stdio.js
 *
 * Nothing but JSON-RPC goes to stdout. Anything a human should see goes to
 * stderr, because a stray `console.log` on stdout corrupts the stream.
 */

import { createInterface } from 'node:readline'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { resolveHome } from '../lib/engine/install.js'
import { SupercolliderSession } from '../lib/engine/session.js'
import { buildTools, TOOL_NAMES } from '../lib/tools.js'

/** The protocol versions this server understands, newest first. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

/** The version this server reports. It must equal package.json's. */
const SERVER_VERSION = '0.1.0-alpha.2'

/** The instructions a client may show the model. */
const INSTRUCTIONS = [
  'SuperCollider control. Call sc_status first to learn what is installed and what is running, then sc_play to check the audio path.',
  'Before writing an instrument from nothing, call sc_project with action=examples: this package ships sixteen playable instruments (a modal gong, an FM bell, a plucked string, drum voices, drones, granular and feedback textures, a theremin) and action=examples file="3" loads one into the live session.',
  'After building any sound, call sc_capture on it: it plays the def, records its own output and reports peak, RMS, clipping, tonality and the strongest partials, so "it sounds like noise" becomes a number you can act on.',
  'sc_exec runs code in a session that stays alive: everything it defines is still there on the next call, which is what makes live editing possible.',
  'sc_help searches the SuperCollider reference installed on this machine - read it before naming a UGen or an argument you are not certain about.',
].join(' ')

/** A logger that can only write to stderr: stdout belongs to the protocol. */
const log = {
  info: (text) => process.stderr.write('[dsh-supercollider] ' + text + '\n'),
  warn: (text) => process.stderr.write('[dsh-supercollider] ' + text + '\n'),
  debug: () => {},
}

/**
 * Turn the tools' declared JSON Schema into the shape MCP wants.
 *
 * The tool definitions were written for the harness, which reads `parameters` as
 * a raw JSON Schema. MCP says the same field is `inputSchema`, and a client that
 * validates strictly will look for `type: "object"` there, so it is passed
 * through after that one rename.
 *
 * @param tool - one tool definition.
 * @returns the MCP tool record.
 */
export function mcpTool(tool) {
  const parameters = tool.parameters ?? { type: 'object', properties: {} }
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', ...parameters, additionalProperties: parameters.additionalProperties ?? false },
  }
}

/**
 * The text an MCP client shows for one tool result.
 *
 * The tools return `{ text, view }`; the model reads `text`, and `view` is the
 * harness's card. Over MCP there is no card, so only `text` is sent — and when
 * the tool reported `view.ok === false`, the result is marked as an error so a
 * client can render it as one.
 *
 * @param value - what `execute` returned.
 * @returns `{ content, isError }`.
 */
export function mcpResult(value) {
  const text = value && typeof value.text === 'string' ? value.text : JSON.stringify(value)
  const isError = Boolean(value && value.view && value.view.ok === false)
  return { content: [{ type: 'text', text }], isError }
}

/** One JSON-RPC error object. */
function rpcError(code, message, data) {
  return { jsonrpc: '2.0', error: { code, message, ...(data === undefined ? {} : { data }) } }
}

/**
 * The server: a session, the tools, and the request loop.
 */
export class McpStdioServer {
  /**
   * @param options - `{ env, cwd }`.
   */
  constructor(options = {}) {
    this.env = options.env ?? process.env
    this.home = resolveHome(this.env)
    this.session = new SupercolliderSession({ home: this.home, env: this.env, log })
    this.tools = new Map()
    for (const tool of buildTools({ session: this.session, env: this.env, log })) {
      this.tools.set(tool.name, tool)
    }
    /** The negotiated protocol version. */
    this.protocolVersion = PROTOCOL_VERSIONS[0]
    /** Whether the client has said `notifications/initialized`. */
    this.initialized = false
    /** In-flight calls, so a cancellation can reach them. */
    this.inflight = new Map()
  }

  /**
   * Handle one JSON-RPC message.
   *
   * @param message - the parsed request or notification.
   * @returns the response object, or null for a notification.
   */
  async handle(message) {
    const id = message.id
    const method = message.method
    const params = message.params ?? {}

    if (method === 'notifications/initialized') {
      this.initialized = true
      return null
    }
    if (method === 'notifications/cancelled' || method === 'notifications/progress') return null

    if (method === 'initialize') {
      const requested = params.protocolVersion
      const chosen = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1]
      this.protocolVersion = chosen
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: chosen,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'dsh-supercollider', version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        },
      }
    }

    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }

    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: [...this.tools.values()].map(mcpTool) } }
    }

    if (method === 'tools/call') {
      const name = params.name
      const tool = this.tools.get(name)
      if (tool === undefined) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool: ' + String(name), data: { available: [...this.tools.keys()] } } }
      }
      const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments
      // An `AbortController` per call: a `notifications/cancelled` from the
      // client aborts it, which every tool forwards to its engine call.
      const controller = new AbortController()
      const exec = { signal: controller.signal, agent: null }
      this.inflight.set(id, controller)
      try {
        const value = await tool.execute(args, exec)
        return { jsonrpc: '2.0', id, result: mcpResult(value) }
      } catch (err) {
        const message2 = err && err.message ? String(err.message) : String(err)
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: name + ' failed: ' + message2 }], isError: true } }
      } finally {
        this.inflight.delete(id)
      }
    }

    if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } }
    if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } }

    if (id === undefined) return null
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + String(method) } }
  }

  /** In-flight calls, so a cancellation can reach them. */

  /**
   * Run the loop until stdin closes.
   *
   * @param input - a readable stream (stdin by default).
   * @param output - a writable stream (stdout by default).
   */
  async run(input = process.stdin, output = process.stdout) {
    const lines = createInterface({ input, crlfDelay: Infinity })
    for await (const line of lines) {
      const text = line.trim()
      if (text === '') continue
      let message
      try {
        message = JSON.parse(text)
      } catch (err) {
        output.write(JSON.stringify(rpcError(-32700, 'the request is not valid JSON')) + '\n')
        continue
      }
      // A batch is legal JSON-RPC but no MCP client sends one; refuse it loudly
      // rather than answering something the client will not match to a request.
      if (Array.isArray(message)) {
        output.write(JSON.stringify(rpcError(-32600, 'batched requests are not supported')) + '\n')
        continue
      }
      let answer
      try {
        answer = await this.handle(message)
      } catch (err) {
        answer = message && message.id !== undefined ? rpcError(-32603, 'internal error: ' + (err && err.message ? err.message : String(err))) : null
        if (answer !== null) answer.id = message.id
      }
      if (answer !== null) output.write(JSON.stringify(answer) + '\n')
    }
    await this.dispose()
    return 0
  }

  /** Stop the interpreter and the socket. A spawned server is left running. */
  async dispose() {
    await this.session.dispose()
  }
}

/** The entry point, when this file is run directly. */
function isDirectRun() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch (err) {
    return false
  }
}

if (isDirectRun()) {
  const server = new McpStdioServer({})
  process.stderr.write('[dsh-supercollider] MCP over stdio — ' + TOOL_NAMES.length + ' tools: ' + TOOL_NAMES.join(', ') + '\n')
  server
    .run()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      process.stderr.write('[dsh-supercollider] fatal: ' + (err && err.stack ? err.stack : String(err)) + '\n')
      process.exitCode = 1
    })
}

export { PROTOCOL_VERSIONS, SERVER_VERSION, INSTRUCTIONS, log }
