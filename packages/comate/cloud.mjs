// Cloud transport inspired by Liu-LingYu's MIT magpie-comate-auth 0.2.13.
// Keep our transcript, nonce, validation and discovery contracts. No desktop
// execution endpoint, shared remote conversation cache or silent fallback.
import { randomUUID } from "node:crypto"
import * as discovery from "./discovery.mjs"
import { buildQuery, events } from "./protocol.mjs"

const ORIGIN = "https://comate.baidu.com"
const API = "/api/aidevops/autocomate/rest/autowork/v2"
const VERSION = "1.8.0"
const str = (x) => typeof x === "string" ? x : ""
const frame = (x) => `data: ${JSON.stringify(x)}\n\n`

export function cloudHooks(hooks, options = {}, shared) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  // Alternate origins are only for explicitly injected test transports.
  const origin = options.cloudOrigin && options.fetchImpl ? new URL(options.cloudOrigin).origin : ORIGIN
  const timeout = options.timeoutMs ?? 300_000
  const aliases = new Map()
  const redact = (s, license) => String(s).split(license).join("[redacted]").split(encodeURIComponent(license)).join("[redacted]")
  const failure = (status, message, license = "") => new Response(JSON.stringify({ error: { type: "comate_error", message: license ? redact(message, license) : String(message), code: status } }), {
    status, headers: { "content-type": "application/json", "X-Magpie-Sign-In": status === 401 ? "expired" : "kept" },
  })
  async function post(path, body, license, signal, sse = false) {
    const response = await fetchImpl(origin + path, {
      method: "POST", redirect: "error", signal,
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
  }
  const credential = (getAuth) => discovery.credential(getAuth, { ...(options.discoveryOptions ?? options), port: 8741 })
  hooks.config = async (config) => {
    config.provider ??= {}
    config.provider.comate ??= {}
    Object.assign(config.provider.comate, { name: "Comate", npm: "@ai-sdk/openai-compatible", api: ORIGIN + "/v1" })
    config.provider.comate.models ??= {}
  }
  hooks.provider.models = async (provider, { auth } = {}) => {
    if (!discovery.isComate(auth)) return provider.models
    let a
    try {
      a = await credential(async () => auth)
      const data = await post("/api/v2/api/models/available", { username: a.license, type: "ZULU", rootRepo: "", submodules: [], zuluVersion: VERSION, source: "plugin", ideType: "zulucli" }, a.license, AbortSignal.timeout(15_000))
      const list = (Array.isArray(data) ? data : data?.models ?? []).filter(m => str(m?.modelId))
      if (!list.length) throw new Error("No live models")
      const names = new Map()
      for (const m of list) for (const n of [m.modelType, m.displayName]) if (str(n)) names.set(n, m.modelId)
      for (const m of list) names.set(m.modelId, m.modelId)
      aliases.set(a.license, names)
      while (aliases.size > 64) aliases.delete(aliases.keys().next().value)
      // Reuse the existing accurate capabilities and numeric-limit projection.
      const _internal = shared
      return Object.fromEntries(list.map(m => [m.modelId, _internal.modelOf(provider, { ...m, thinking: m.thinking ?? m.supportThinking === true }, ORIGIN)]))
    } catch {
      if (a) aliases.delete(a.license)
      return provider.models
    }
  }
  hooks.auth.loader = async (getAuth) => {
    if (!discovery.isComate(await getAuth())) return {}
    return { baseURL: ORIGIN + "/v1", apiKey: "", async fetch(input, init = {}) {
      let a
      let activeController
      try {
        let chat
        try { chat = JSON.parse(await shared.bodyText(input, init)) } catch { return failure(400, "Invalid chat request JSON") }
        const _internal = shared
        if (!Array.isArray(chat?.messages) || !_internal.isTextOnly(chat.messages) || !_internal.hasTextContent(chat.messages)) return failure(400, "Comate currently accepts non-empty text conversations only")
        const request = buildQuery(chat, randomUUID().replaceAll("-", ""))
        a = await credential(getAuth)
        if (!a) return failure(401, "Comate is not signed in")
        const want = str(chat.model).replace(/^comate\//, "")
        const model = aliases.get(a.license)?.get(want) ?? want
        if (!model) return failure(400, "The request names no model")
        const outer = init.signal ?? (input instanceof Request ? input.signal : undefined)
        const controller = activeController = new AbortController()
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout), ...(outer ? [outer] : [])])
        signal.throwIfAborted()
        const client = { username: a.license, ide: "zulucli", ideVersion: VERSION, pluginVersion: VERSION }
        // Fresh remote state on every request: client history owns continuation,
        // so account/model switches, concurrent sessions and host restarts cannot
        // reuse another request's pending tools. Never retry mutating POSTs.
        const common = { ...client, agentInfo: { agentName: "magpie", isProjectAgent: false } }
        const conversation = await post(API + "/conversation", common, a.license, signal)
        const conversationId = conversation?.id ?? conversation?.data?.id
        if (conversationId == null) throw new Error("Comate returned no conversation id")
        const task = await post(API + "/task", { ...common, conversationId }, a.license, signal)
        const taskId = task?.taskId ?? task?.data?.taskId
        if (taskId == null) throw new Error("Comate returned no task id")
        const response = await post(API + "/execute", {
          ...common, conversationId, taskId, query: request.query, modelKey: model, modelProvider: "Auto",
          tools: request.toolSpec.enabled ? request.toolSpec.tools : [],
          uploadBaseInfo: { os: process.platform === "win32" ? "windows" : process.platform, ideType: "zulucli", ideName: "zulucli", ideVersion: VERSION, extName: "zulucli", extVersion: VERSION, license: a.license, username: a.who ?? "", pluginVersion: VERSION, triggerSource: "API" },
          sysInfo: {}, skillInfos: [], hasMcp: false, isUserQuery: true, isMockQuery: false, localIndex: 0,
          contexts: [], toolUseResults: [], subAgents: [], subAgentsChanged: false, systemReminder: "", extendUserQueryInfo: { commands: [], skills: [], subagents: [], rules: [] }, extend: { isMultiWorkspace: false, useWorkflow: false }, sendMode: "normal", isFirstQuery: true, enableMemory: false,
        }, a.license, signal, true)
        const body = cloudBody(response.body, request.toolSpec)
        const adapted = new Response(body, { headers: { "content-type": "text/event-stream" } })
        // Retain our existing streaming parser, choice validation and cancellation.
        const taskControl = { controller, cancelled: false, cleanup() {}, finish() { controller.abort() }, async cancel() { this.cancelled = true; controller.abort(); await body.cancel().catch(() => {}) } }
        return chat.stream === true
          ? _internal.streamed(chat, adapted, taskControl, request.toolSpec, randomUUID, a.license)
          : await _internal.finished(chat, adapted, taskControl, request.toolSpec, randomUUID, a.license)
      } catch (error) {
        activeController?.abort()
        if (error.name === "AbortError") throw error
        if (error.name === "ProtocolRequestError") return failure(400, error.message)
        return failure(error.status === 401 || error.status === 403 || error.signIn === "expired" ? 401 : error.status === 400 ? 400 : 502, error.message, a?.license)
      }
    } }
  }
  return hooks
}

function cloudBody(body, spec) {
  const live = new Map()
  const completed = []
  let hasText = false
  const encoder = new TextEncoder()
  async function* convert() {
    try {
      for await (const event of events(body)) {
        const c = event?.content
        if (!c || typeof c.type !== "string") throw new Error("Unexpected Comate cloud event envelope")
        const d = c.detail ?? {}
        if (["EXCEPTION", "QUOTA_EXCEED", "TOOL"].includes(c.type)) throw new Error(`Comate cloud stopped: ${c.type}`)
        if (c.type.startsWith("FUNCTION_CALL_")) {
          for (const t of d.toolUse ?? []) {
            if (!str(t.id)) throw new Error("Cloud tool call has no id")
            const call = live.get(t.id) ?? { name: str(t.name), input: {} }
            if (t.name) call.name = t.name
            for (const [key, value] of Object.entries(t.input ?? {})) {
              call.input[key] = c.type === "FUNCTION_CALL_PARAMS_APPEND" && typeof value === "string" ? (call.input[key] ?? "") + value : value
            }
            live.set(t.id, call)
            if (c.type === "FUNCTION_CALL_END") {
              if (!spec.enabled || !spec.byName.has(call.name)) throw new Error("Comate requested a tool the client did not offer")
              completed.push({ name: call.name, arguments: call.input })
              live.delete(t.id)
              if (completed.length > 64) throw new Error("Too many cloud tool calls")
            }
          }
        }
        if (c.type === "ANSWER") {
          if (str(d.reasoningDelta)) yield frame({ kind: "thinking-delta", delta: d.reasoningDelta })
          if (str(d.delta)) { hasText = true; yield frame({ kind: "text-delta", delta: d.delta }) }
          if (d.end === true) {
            if (live.size) throw new Error("Comate ended with incomplete tool arguments")
            if (!hasText && !completed.length) throw new Error("Comate completed without an answer or tool call")
            if (completed.length) yield frame({ kind: "text-delta", delta: spec.startTag + JSON.stringify(completed) + spec.endTag })
            yield frame({ type: "task_done", status: "completed" })
            return
          }
        }
      }
      throw new Error("Comate stream ended before its completion event")
    } catch (error) {
      yield frame({ type: "task_failed", errorMessage: error.message })
    }
  }
  const iterator = convert()
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next()
      if (next.done) controller.close()
      else controller.enqueue(encoder.encode(next.value))
    },
    async cancel() { await iterator.return(); await body.cancel().catch(() => {}) },
  }, { highWaterMark: 0 })
}
