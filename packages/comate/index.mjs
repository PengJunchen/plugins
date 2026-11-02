import { randomUUID as nodeRandomUUID } from "node:crypto"
import * as discovery from "./discovery.mjs"
import { cloudHooks } from "./cloud.mjs"
import {
  buildQuery,
  comatePieces,
  consumeComateSSE,
  events,
  MAX_TOOL_CALLS,
  newState,
  parseToolCalls,
  piecesOf,
  ProtocolRequestError,
  queryOf,
  ToolTextParser,
} from "./protocol.mjs"

const SITE = { id: "comate", name: "Comate" }
const NPM = "@ai-sdk/openai-compatible"
const PORT_FALLBACK = 8741
const LIST_TIMEOUT_MS = 15_000
const CANCEL_TIMEOUT_MS = 1_500

const string = (value) => (typeof value === "string" ? value : "")
const httpStatus = (status) => `HTTP ${status}`

function safeMessage(message, secret) {
  const text = string(message) || "Comate request failed"
  if (!secret) return text
  let safe = text.split(secret).join("[redacted]")
  try {
    const encoded = encodeURIComponent(secret)
    if (encoded !== secret) safe = safe.split(encoded).join("[redacted]")
  } catch {}
  return safe
}

function errorResponse(status, message, signIn, secret = "") {
  return new Response(JSON.stringify({ error: { message: safeMessage(message, secret), type: "comate_error", code: status } }), {
    status,
    headers: {
      "content-type": "application/json",
      ...(signIn ? { "X-Magpie-Sign-In": signIn } : {}),
    },
  })
}

function apiErrorChunk(message, secret) {
  return `data: ${JSON.stringify({ error: { message: safeMessage(message, secret), type: "api_error", code: "comate_error" } })}\n\n`
}

const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"])

function isTextPart(part) {
  if (typeof part === "string") return true
  if (!part || typeof part !== "object" || Array.isArray(part)) return false
  const type = string(part.type).toLowerCase()
  if (type ? !TEXT_PART_TYPES.has(type) : typeof part.text !== "string") return false
  if (part.image_url || part.audio_url || part.video_url || part.source !== undefined) return false
  return true
}

function isTextOnly(messages) {
  for (const message of messages ?? []) {
    const content = message?.content
    if (content === undefined || content === null || typeof content === "string") continue
    if (Array.isArray(content)) {
      if (!content.every(isTextPart)) return false
      continue
    }
    if (!isTextPart(content)) return false
  }
  return true
}

function textContent(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : string(part?.text)).join("")
  }
  if (content && typeof content === "object") return string(content.text)
  return ""
}

function hasTextContent(messages) {
  return Array.isArray(messages) && messages.some((message) => textContent(message?.content).trim() !== "")
}

function modelIdOf(chat, modelAliases = new Map()) {
  const original = string(chat?.model).trim()
  const unprefixed = original.startsWith(`${SITE.id}/`) ? original.slice(SITE.id.length + 1) : original
  return modelAliases.get(unprefixed) ?? modelAliases.get(unprefixed.toLowerCase()) ?? unprefixed
}

// Use only explicit numeric limits. Zero is the host's unknown sentinel, not
// a measured context size; never infer a window from an account's model name.
function modelLimits(model) {
  const positive = (value) => Number.isSafeInteger(value) && value > 0 ? value : 0
  const input = positive(model?.limit?.input)
  return {
    context: positive(model?.limit?.context),
    output: positive(model?.limit?.output),
    ...(input ? { input } : {}),
  }
}

function aliasesOf(list) {
  const aliases = new Map()
  for (const model of list) {
    for (const alias of [model.modelType, model.displayName]) {
      if (typeof alias === "string" && alias) {
        aliases.set(alias, model.modelId)
        aliases.set(alias.toLowerCase(), model.modelId)
      }
    }
  }
  // An exact live model ID takes precedence over any display-name alias.
  for (const model of list) aliases.set(model.modelId, model.modelId)
  return aliases
}

function credentialKey(credential, base) {
  return JSON.stringify([base, credential.license])
}

function modelOf(provider, model, base) {
  const thinking = model?.thinking === true
  const image = model?.supportImage === true
  return {
    id: model.modelId,
    providerID: provider?.id ?? SITE.id,
    name: string(model.displayName) || model.modelId,
    api: { id: model.modelId, url: base, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: modelLimits(model),
    capabilities: {
      temperature: false,
      reasoning: thinking,
      attachment: image,
      toolcall: true,
      input: { text: true, image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

async function bodyText(input, init) {
  const body = init?.body ?? (typeof Request !== "undefined" && input instanceof Request ? await input.clone().text() : undefined)
  if (body === undefined || body === null) return ""
  if (typeof body === "string") return body
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body)
  try {
    return await new Response(body).text()
  } catch {
    return ""
  }
}

async function said(response, secret) {
  const text = await response.text().catch(() => "")
  let message = text.trim().slice(0, 500) || httpStatus(response.status)
  try {
    const value = JSON.parse(text)
    message = string(value?.error?.message) || string(value?.error) || string(value?.message) || string(value?.msg) || message
  } catch {}
  return safeMessage(message, secret)
}

function isAbortError(error) {
  return error?.name === "AbortError"
}

function abortError() {
  return new DOMException("The operation was aborted", "AbortError")
}

function toolCallIds(calls, uuid) {
  return calls.map((call) => ({
    id: `call_${uuid().replaceAll("-", "").slice(0, 24)}`,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }))
}

function completionResult(chat, result, toolSpec, uuid) {
  const parsed = parseToolCalls(result.text, toolSpec)
  if (parsed.invalid) {
    return { error: `Comate did not produce a valid requested tool call: ${parsed.invalid}` }
  }
  const calls = parsed.calls
  const toolCalls = toolCallIds(calls, uuid)
  const message = {
    role: "assistant",
    content: toolCalls.length ? (parsed.content || null) : parsed.content,
  }
  if (result.reasoning) message.reasoning_content = result.reasoning
  if (toolCalls.length) message.tool_calls = toolCalls
  return {
    body: {
      id: `chatcmpl-${uuid().replaceAll("-", "").slice(0, 24)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: string(chat.model),
      choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    },
    toolCalls,
  }
}

function chunkEncoder(chat, uuid) {
  const id = `chatcmpl-${uuid().replaceAll("-", "").slice(0, 24)}`
  const created = Math.floor(Date.now() / 1000)
  const model = string(chat.model)
  const encode = (delta, finish = null) => `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
  return { encode, done: "data: [DONE]\n\n" }
}

async function finished(chat, response, task, toolSpec, uuid, license) {
  let result
  try {
    result = await consumeComateSSE(response.body)
  } catch (error) {
    if (task.cancelled || isAbortError(error)) throw error
    await task.cancel()
    return errorResponse(502, `Comate reply could not be read: ${error?.message ?? error}`, "kept", license)
  }

  if (result.terminal) task.finish()
  else await task.cancel()
  if (!result.ok) { task.cleanup(); return errorResponse(502, result.error, "kept", license) }

  const completion = completionResult(chat, result, toolSpec, uuid)
  if (completion.error) { task.cleanup(); return errorResponse(502, completion.error, "kept", license) }
  task.succeed?.(completion.toolCalls)
  task.cleanup()
  return new Response(JSON.stringify(completion.body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function streamed(chat, response, task, toolSpec, uuid, license) {
  const encoder = new TextEncoder()
  const chunks = chunkEncoder(chat, uuid)

  async function* output() {
    const parser = new ToolTextParser(toolSpec)
    const requiresTool = toolSpec.choice === "required" || toolSpec.choice === "named"
    yield chunks.encode({ role: "assistant" })
    let terminal = false
    let failed = ""
    try {
      for await (const piece of comatePieces(response.body)) {
        if (piece.text) {
          for (const part of parser.push(piece.text)) yield chunks.encode({ content: part.text })
        } else if (piece.reasoning) {
          if (!requiresTool) yield chunks.encode({ reasoning_content: piece.reasoning })
        } else if (piece.exception) {
          failed = piece.exception
          break
        } else if (piece.missing) {
          failed = "Comate stream ended before a terminal task event."
          break
        } else if (piece.done) {
          terminal = true
          task.finish()
          if (piece.status !== "completed") failed = `Comate task failed: ${piece.errorMessage || piece.status || "unknown status"}`
          break
        }
      }
      if (!terminal && !failed) failed = "Comate stream ended before a terminal task event."
      if (failed) {
        if (!terminal) await task.cancel()
        yield apiErrorChunk(failed, license)
        yield chunks.done
        return
      }

      const final = parser.finish()
      if (final.invalid) {
        yield apiErrorChunk(`Comate did not produce a valid requested tool call: ${final.invalid}`, license)
        yield chunks.done
        return
      }
      if (final.text) yield chunks.encode({ content: final.text })
      const calls = toolCallIds(final.calls, uuid)
      task.succeed?.(calls)
      if (final.calls.length) {
        for (const [index, item] of calls.entries()) {
          yield chunks.encode({ tool_calls: [{ index, id: item.id, type: item.type, function: { name: item.function.name, arguments: "" } }] })
        }
        for (const [index, item] of calls.entries()) {
          yield chunks.encode({ tool_calls: [{ index, function: { arguments: item.function.arguments } }] })
        }
      }
      yield chunks.encode({}, final.calls.length ? "tool_calls" : "stop")
      yield chunks.done
    } catch (error) {
      if (task.cancelled) return
      if (!task.controller.signal.aborted) await task.cancel()
      yield apiErrorChunk(`Comate reply could not be read: ${error?.message ?? error}`, license)
      yield chunks.done
    } finally {
      task.cleanup()
    }
  }

  const iterator = output()
  let closed = false
  let pulling = false
  return new Response(new ReadableStream({
    async pull(controller) {
      if (closed || pulling) return
      pulling = true
      try {
        const next = await iterator.next()
        if (next.done) {
          closed = true
          controller.close()
        } else controller.enqueue(encoder.encode(next.value))
      } catch (error) {
        if (!task.cancelled) {
          await task.cancel()
          try {
            controller.enqueue(encoder.encode(apiErrorChunk(`Comate reply could not be read: ${error?.message ?? error}`, license)))
            controller.enqueue(encoder.encode(chunks.done))
            controller.close()
          } catch {}
        }
        closed = true
      } finally {
        pulling = false
      }
    },
    async cancel() {
      closed = true
      await task.cancel()
      try { await iterator.return() } catch {}
    },
  }, { highWaterMark: 0 }), {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

function desktopSignIn(discoveryOptions) {
  return {
    url: "",
    instructions: "Uses the Comate account already signed in on this computer.",
    method: "auto",
    async callback() {
      let state
      try {
        state = discovery.readState(discoveryOptions)
      } catch (error) {
        return { type: "failed", error: error.message }
      }
      if (!state) return { type: "failed", error: "Comate isn't signed in on this computer." }
      return {
        type: "success",
        refresh: "",
        access: state.license,
        expires: 0,
        source: "comate",
        accountId: state.username || SITE.name,
        uid: state.username || "",
      }
    },
  }
}

function licenseSignIn() {
  return {
    type: "api",
    label: "Comate license (paste)",
    placeholder: "Comate license",
    prompts: [
      {
        type: "text",
        key: "license",
        message: "Comate license (baidu.comate.license in Comate settings)",
        validate: (value) => (string(value).trim() ? undefined : "Paste Comate's license"),
      },

    ],
    authorize(inputs) {
      const license = string(inputs?.license).trim()
      if (!license) return { type: "failed", error: "Paste Comate's license" }
      const rawPort = string(inputs?.port).trim()
      const port = rawPort ? Number(rawPort) : 0
      return {
        type: "success",
        key: license,
        metadata: { ...(port ? { port } : {}), source: "comate-paste" },
      }
    },
  }
}

function makePlugin(options = {}) {
  const discoveryOptions = { ...(options.discoveryOptions ?? options), port: 8741 }
  return async () => ({
    provider: { id: SITE.id },
    auth: {
      provider: SITE.id,
      methods: [
        { type: "oauth", label: "Comate account (this computer)", authorize: async () => desktopSignIn(discoveryOptions) },
        licenseSignIn(),
      ],
    },
  })
}

export async function ComateAuthPlugin(input = {}, options = {}) {
  return cloudHooks(await makePlugin(options)(input), options, { modelOf, isTextOnly, hasTextContent, streamed, finished, bodyText })
}

// Magpie loads every function export as a plugin entry; keep all helpers on
// this object so only ComateAuthPlugin is treated as an entry point.
export const _internal = {
  SITE,
  NPM,
  PORT_FALLBACK,
  MAX_TOOL_CALLS,
  buildQuery,
  queryOf,
  parseToolCalls,
  ToolTextParser,
  events,
  piecesOf,
  newState,
  consumeComateSSE,
  modelOf,
  modelLimits,
  modelIdOf,
  errorResponse,
  isTextOnly,
  hasTextContent,
  completionResult,
  streamed,
  finished,
  makePlugin,
  createPlugin: makePlugin,
}
