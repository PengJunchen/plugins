// Cloud wire protocol informed by Liu-LingYu's MIT magpie-comate-auth 0.2.13.
// Only the calling client executes local tools. No desktop-service fallback.
import { randomUUID } from "node:crypto"
import * as discovery from "./discovery.mjs"
import { buildQuery, events } from "./protocol.mjs"
import { normalizeMessages, imagesFrom } from "./images.mjs"
import { clientToolCall } from "./tool-adapter.mjs"
import { SESSION_HEADER, sessionKey, historyHash, catalogHash, continuation, nativeResults } from "./cloud-session.mjs"

const ORIGIN = "https://comate.baidu.com"
const API = "/api/aidevops/autocomate/rest/autowork/v2"
const FILE_API = "/api/aidevops/autocomate/rest/autowork/v1/file"
const VERSION = "1.8.0"
const str = value => typeof value === "string" ? value : ""
const frame = value => `data: ${JSON.stringify(value)}\n\n`
const MAX_SESSIONS = 64
function nativeInstructions(spec) {
  const choice = spec.choice === "required" ? "You must return at least one offered function call." : spec.choice === "named" ? `You must call only ${JSON.stringify(spec.requiredName)}.` : spec.choice === "none" ? "Do not call any function." : "Call an offered function when needed."
  return `You are serving a remote client. Interpret the JSON-lines transcript by its roles and answer its latest turn. Use structured native function calls with the offered tool names and parameters, not textual tool markers or simulated results. The client alone executes tools; wait for its actual results. ${choice} ${spec.parallel ? "" : "Call at most one function."}`
}
const textContent = content => typeof content === "string" ? content : Array.isArray(content) ? content.map(part => str(part?.text)).join("") : str(content?.text)

export function cloudHooks(hooks, options = {}, shared) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const origin = options.cloudOrigin && options.fetchImpl ? new URL(options.cloudOrigin).origin : ORIGIN
  const aliases = new Map(), sessions = new Map(), busy = new Set()
  const credential = getAuth => discovery.credential(getAuth, { ...(options.discoveryOptions ?? options), port: 8741 })
  const redact = (message, license) => String(message).split(license).join("[redacted]").split(encodeURIComponent(license)).join("[redacted]")
  const failure = (status, message, license = "") => new Response(JSON.stringify({ error: { type: "comate_error", message: license ? redact(message, license) : String(message), code: status } }), {
    status, headers: { "content-type": "application/json", "X-Magpie-Sign-In": status === 401 ? "expired" : "kept" },
  })
  function remember(key, value) {
    if (!key) return
    sessions.delete(key)
    sessions.set(key, value)
    for (const old of sessions.keys()) {
      if (sessions.size <= MAX_SESSIONS) break
      if (!busy.has(old)) sessions.delete(old)
    }
  }
  async function post(path, body, license, signal, sse = false) {
    const deadline = new AbortController()
    const ms = path.includes("/file/") ? options.uploadTimeoutMs ?? 30_000 : sse ? options.headerTimeoutMs ?? 300_000 : options.metadataTimeoutMs ?? 15_000
    const timer = setTimeout(() => deadline.abort(new DOMException("Comate cloud did not respond within this phase's deadline", "TimeoutError")), ms)
    try {
      const response = await fetchImpl(origin + path, {
        method: "POST", redirect: "error", signal: AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]),
        headers: { "content-type": "application/json", accept: sse ? "text/event-stream" : "application/json", "login-name": encodeURIComponent(license), "Uuap-login-name": encodeURIComponent(license), "X-Source": "COMATE", "plugin-version": VERSION, "X-Trace-Id": randomUUID() },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw Object.assign(new Error(`Comate cloud HTTP ${response.status}`), { status: response.status })
      }
      if (sse) {
        if (!response.headers.get("content-type")?.includes("text/event-stream")) {
          await response.body?.cancel()
          throw new Error("Comate cloud returned a non-SSE response")
        }
        return response
      }
      const value = await response.json()
      if (value.code != null && ![0, 200].includes(Number(value.code))) throw new Error("Comate cloud rejected the request")
      return value.data
    } finally { clearTimeout(timer) }
  }
  async function upload(images, license, signal) {
    const uploaded = []
    for (const image of images) {
      const data = await post(FILE_API + "/upload", { ...image, scene: "Composer", fileData: image.data, data: undefined }, license, signal)
      const id = typeof data?.id === "number" ? data.id : typeof data?.id === "string" && /^\d+$/.test(data.id) ? Number(data.id) : NaN
      if (!Number.isSafeInteger(id) || id < 0) throw new Error("Comate image upload returned no valid id")
      const url = str(data.url) || `${origin}${FILE_API}/stream/${data.id}?authorization=${Buffer.from(license).toString("base64")}`
      uploaded.push({ id: Number(data.id), name: image.fileName, url })
    }
    return uploaded.length ? [{ type: "IMAGE", imageIds: uploaded.map(image => image.id), images: uploaded }] : []
  }
  hooks.config = async config => {
    config.provider ??= {}
    config.provider.comate ??= {}
    Object.assign(config.provider.comate, { name: "Comate", npm: "@ai-sdk/openai-compatible", api: ORIGIN + "/v1" })
    config.provider.comate.models ??= {}
  }
  hooks["chat.headers"] = async (input, output) => {
    if ((input?.model?.providerID ?? input?.provider?.info?.id) === "comate" && input.sessionID) output.headers[SESSION_HEADER] = String(input.sessionID).slice(0, 128)
  }
  hooks.provider.models = async (provider, { auth } = {}) => {
    if (!discovery.isComate(auth)) return provider.models
    let a
    try {
      a = await credential(async () => auth)
      const data = await post("/api/v2/api/models/available", { username: a.license, type: "ZULU", rootRepo: "", submodules: [], zuluVersion: VERSION, source: "plugin", ideType: "zulucli" }, a.license)
      const list = (Array.isArray(data) ? data : data?.models ?? []).filter(model => str(model?.modelId))
      if (!list.length) throw new Error("No live models")
      const names = new Map()
      for (const model of list) for (const name of [model.modelType, model.displayName]) if (str(name)) names.set(name, model.modelId)
      for (const model of list) names.set(model.modelId, model.modelId)
      aliases.set(a.license, names)
      while (aliases.size > MAX_SESSIONS) aliases.delete(aliases.keys().next().value)
      return Object.fromEntries(list.map(model => [model.modelId, shared.modelOf(provider, { ...model, thinking: model.thinking ?? model.supportThinking === true }, ORIGIN)]))
    } catch {
      if (a) aliases.delete(a.license)
      return provider.models
    }
  }
  hooks.auth.loader = async getAuth => {
    if (!discovery.isComate(await getAuth())) return {}
    return { baseURL: ORIGIN + "/v1", apiKey: "", async fetch(input, init = {}) {
      let a, controller, key = "", acquired = false, handedOff = false
      try {
        let chat
        try { chat = JSON.parse(await shared.bodyText(input, init)) } catch { return failure(400, "Invalid chat request JSON") }
        const normalized = normalizeMessages(chat?.messages)
        if (!shared.hasTextContent(normalized.messages)) return failure(400, "The request needs text or an inline image")
        const request = buildQuery({ ...chat, messages: normalized.messages }, randomUUID().replaceAll("-", ""))
        a = await credential(getAuth)
        if (!a) return failure(401, "Comate is not signed in")
        const want = str(chat.model).replace(/^comate\//, "")
        const model = aliases.get(a.license)?.get(want) ?? want
        if (!model) return failure(400, "The request names no model")
        const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : {}))
        key = sessionKey(a.license, model, (headers.get(SESSION_HEADER) ?? "").slice(0, 128))
        if (key && busy.has(key)) return failure(409, "This Comate session already has an active request", a.license)
        if (busy.size >= MAX_SESSIONS) return failure(429, "Too many concurrent Comate sessions", a.license)
        if (key) { busy.add(key); acquired = true }
        const catalog = catalogHash(chat)
        const previous = continuation(sessions.get(key), chat.messages, catalog)
        const from = previous?.count ?? 0
        const native = previous ? nativeResults(previous, normalized.messages, normalized.images, textContent) : { results: [], indices: new Set() }
        const newMessages = normalized.messages.slice(from).filter((message, offset) => message.role !== "assistant" && !native.indices.has(from + offset))
        const instructions = nativeInstructions(request.toolSpec)
        const query = previous ? newMessages.map(message => JSON.stringify(message)).join("\n") : instructions + "\n\nConversation transcript:\n" + normalized.messages.map(message => JSON.stringify(message)).join("\n")
        if (!query && !native.results.length) throw new Error("The continuation contains no new input or tool results")
        const requestImages = imagesFrom(normalized.images, from, native.indices)
        const outer = init.signal ?? (input instanceof Request ? input.signal : undefined)
        controller = new AbortController()
        // No turn-wide timer. Headers, uploads and an idle stream have separate
        // deadlines; a continuously producing task can run for any duration.
        const signal = AbortSignal.any([controller.signal, ...(outer ? [outer] : [])])
        signal.throwIfAborted()
        const client = { username: a.license, ide: "zulucli", ideVersion: VERSION, pluginVersion: VERSION }
        const common = { ...client, agentInfo: { agentName: "magpie", isProjectAgent: false } }
        let conversationId = previous?.conversationId, taskId = previous?.taskId
        if (!previous) {
          const conversation = await post(API + "/conversation", common, a.license, signal)
          conversationId = conversation?.id ?? conversation?.data?.id
          if (conversationId == null) throw new Error("Comate returned no conversation id")
          const task = await post(API + "/task", { ...common, conversationId }, a.license, signal)
          taskId = task?.taskId ?? task?.data?.taskId
          if (taskId == null) throw new Error("Comate returned no task id")
        }
        const contexts = await upload(requestImages, a.license, signal)
        // Mutating POSTs are never retried silently: an ambiguous network error
        // must not submit the same user query or tool result twice.
        const response = await post(API + "/execute", {
          ...common, conversationId, taskId, query, modelKey: model, modelProvider: "Auto",
          tools: request.toolSpec.enabled ? request.toolSpec.tools.map(tool => ({ ...tool, function: { ...tool.function, name: request.toolSpec.byName.get(tool.function.name) } })) : [],
          uploadBaseInfo: { os: process.platform === "win32" ? "windows" : process.platform, ideType: "zulucli", ideName: "zulucli", ideVersion: VERSION, extName: "zulucli", extVersion: VERSION, license: a.license, username: a.who ?? "", pluginVersion: VERSION, triggerSource: "API" },
          sysInfo: {}, skillInfos: [], hasMcp: false, isUserQuery: !native.results.length || newMessages.some(message => message.role === "user"), isMockQuery: false, localIndex: 0,
          contexts, toolUseResults: native.results, subAgents: [], subAgentsChanged: false,
          systemReminder: instructions,
          extendUserQueryInfo: { commands: [], skills: [], subagents: [], rules: [] }, extend: { isMultiWorkspace: false, useWorkflow: false }, sendMode: "normal", isFirstQuery: !previous, enableMemory: false,
        }, a.license, signal, true)
        const nativeCalls = []
        const adapted = new Response(cloudBody(response.body, request.toolSpec, nativeCalls, controller, signal, options.streamIdle), { headers: { "content-type": "text/event-stream" } })
        let committed = false
        const cleanup = () => { if (!committed && key) sessions.delete(key); if (acquired) busy.delete(key) }
        const taskControl = {
          controller, cancelled: false, cleanup,
          finish() { controller.abort() },
          async cancel() { this.cancelled = true; cleanup(); controller.abort(); await adapted.body.cancel().catch(() => {}) },
          succeed(calls) {
            const remaining = [...nativeCalls]
            const pending = []
            for (const call of calls) {
              const index = remaining.findIndex(native => (native.clientName ?? request.toolSpec.byName.get(native.name)) === call.function.name && JSON.stringify(native.clientInput ?? native.input) === call.function.arguments)
              if (index >= 0) pending.push({ ...remaining.splice(index, 1)[0], clientId: call.id })
            }
            if (remaining.length) throw new Error("Cloud/client tool correlation failed")
            remember(key, { conversationId, taskId, pending, catalog, count: chat.messages.length, hash: historyHash(chat.messages) })
            committed = true
            cleanup()
          },
        }
        const result = chat.stream === true
          ? shared.streamed(chat, adapted, taskControl, request.toolSpec, randomUUID, a.license)
          : await shared.finished(chat, adapted, taskControl, request.toolSpec, randomUUID, a.license)
        handedOff = true
        return result
      } catch (error) {
        controller?.abort()
        if (acquired) { sessions.delete(key); busy.delete(key) }
        if (error.name === "AbortError") throw error
        return failure(error.status === 401 || error.status === 403 || error.signIn === "expired" ? 401 : error.name === "ProtocolRequestError" || error.status === 400 ? 400 : 502, error.message, a?.license)
      } finally {
        if (!handedOff && acquired) busy.delete(key)
      }
    } }
  }
  return hooks
}

async function* timedBytes(body, controller, signal, { firstMs = 300_000, idleMs = 180_000 } = {}) {
  const reader = body.getReader()
  let received = false
  try {
    for (;;) {
      signal.throwIfAborted()
      const budget = received ? idleMs : firstMs
      let timer, onAbort
      const stalled = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
        signal.addEventListener("abort", onAbort, { once: true })
        if (budget > 0) timer = setTimeout(() => {
          const error = new Error(`Comate stream was idle for ${budget}ms; retry the turn`)
          reject(error)
          controller.abort(error)
        }, budget)
      })
      let result
      try { result = await Promise.race([reader.read(), stalled]) }
      finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort) }
      if (result.done) return
      received = true
      yield result.value
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function cloudBody(body, spec, nativeCalls, controller, signal, idle) {
  const live = new Map(), completed = []
  let hasText = false
  const encoder = new TextEncoder()
  async function* convert() {
    try {
      for await (const event of events(timedBytes(body, controller, signal, idle))) {
        const content = event?.content
        if (!content || typeof content.type !== "string") throw new Error("Unexpected Comate cloud event envelope")
        const detail = content.detail ?? {}
        if (["EXCEPTION", "QUOTA_EXCEED", "TOOL"].includes(content.type)) throw new Error(`Comate cloud stopped: ${content.type}`)
        if (content.type.startsWith("FUNCTION_CALL_")) {
          for (const tool of detail.toolUse ?? []) {
            if (!str(tool.id)) throw new Error("Cloud tool call has no id")
            const call = live.get(tool.id) ?? { id: tool.id, name: str(tool.name), input: {} }
            if (tool.name) call.name = tool.name
            for (const [key, value] of Object.entries(tool.input ?? {})) call.input[key] = content.type === "FUNCTION_CALL_PARAMS_APPEND" && typeof value === "string" ? (call.input[key] ?? "") + value : value
            live.set(tool.id, call)
            if (content.type === "FUNCTION_CALL_END") {
              const clientCall = clientToolCall(call, spec)
              nativeCalls.push({ ...call, clientName: spec.byName.get(clientCall.name) ?? clientCall.name, clientInput: clientCall.input })
              completed.push({ name: clientCall.name, arguments: clientCall.input })
              live.delete(tool.id)
              if (completed.length > 64) throw new Error("Too many cloud tool calls")
            }
          }
        }
        if (content.type === "ANSWER") {
          if (str(detail.reasoningDelta)) yield frame({ kind: "thinking-delta", delta: detail.reasoningDelta })
          if (str(detail.delta)) { hasText = true; yield frame({ kind: "text-delta", delta: detail.delta }) }
          if (detail.end === true) {
            if (live.size) throw new Error("Comate ended with incomplete tool arguments")
            if (!hasText && !completed.length) throw new Error("Comate completed without an answer or tool call")
            if (completed.length) yield frame({ kind: "text-delta", delta: spec.startTag + JSON.stringify(completed) + spec.endTag })
            yield frame({ type: "task_done", status: "completed" })
            return
          }
        }
      }
      throw new Error("Comate stream ended before its completion event")
    } catch (error) { yield frame({ type: "task_failed", errorMessage: error.message }) }
  }
  const iterator = convert()
  return new ReadableStream({
    async pull(stream) { const next = await iterator.next(); if (next.done) stream.close(); else stream.enqueue(encoder.encode(next.value)) },
    async cancel() { controller.abort(); await iterator.return() },
  }, { highWaterMark: 0 })
}
