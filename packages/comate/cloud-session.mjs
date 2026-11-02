import { createHash } from "node:crypto"

export const SESSION_HEADER = "x-magpie-comate-session"
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex")
export const sessionKey = (license, model, session) => session ? digest([license, model, session]) : ""
export const historyHash = messages => digest(messages)
export const catalogHash = chat => digest([chat.tools ?? [], chat.tool_choice ?? "auto", chat.parallel_tool_calls !== false])

export function continuation(previous, messages, catalog) {
  if (!previous || previous.catalog !== catalog || messages.length <= previous.count || historyHash(messages.slice(0, previous.count)) !== previous.hash) return null
  // The assistant response must be part of the continuation; a different
  // branch or an identical retried input starts fresh rather than appending.
  if (messages[previous.count]?.role !== "assistant" || messages.slice(previous.count).filter(message => message.role === "assistant").length !== 1) return null
  return previous
}

export function nativeResults(previous, messages, images, textContent) {
  const pending = previous.pending ?? []
  if (!pending.length) return { results: [], indices: new Set() }
  const results = [], indices = new Set(), seen = new Set()
  for (let index = previous.count; index < messages.length; index++) {
    const message = messages[index]
    if (message.role !== "tool") continue
    const call = pending.find(call => call.clientId === message.tool_call_id)
    if (!call || seen.has(call.clientId)) throw new Error("Tool result ID does not match the pending cloud calls")
    const attachments = images.get(index) ?? []
    if (attachments.length > 1) throw new Error("A native tool result supports one image; return additional images in a user message")
    results.push({
      id: call.id, name: call.name, params: call.input,
      success: message.isError !== true && message.is_error !== true,
      message: textContent(message.content),
      ...(attachments.length ? { result: { type: "image", source: { type: "base64", media_type: attachments[0].contentType, data: attachments[0].data } } } : {}),
    })
    indices.add(index)
    seen.add(call.clientId)
  }
  if (results.length !== pending.length) throw new Error("Return all pending tool results before continuing this cloud task")
  return { results, indices }
}
