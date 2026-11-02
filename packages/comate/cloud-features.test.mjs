import test from "node:test"
import assert from "node:assert/strict"
import { setImmediate as nextTick } from "node:timers/promises"
import { ComateAuthPlugin } from "./index.mjs"
import { normalizeMessages, IMAGE_MAX_BYTES } from "./images.mjs"

const tools = [{ type: "function", function: { name: "echo", parameters: { type: "object", properties: { text: { type: "string" } } } } }]
const user = content => ({ role: "user", content })
const answer = text => [{ content: { type: "ANSWER", detail: { delta: text, end: true } } }]
const toolAnswer = name => [
  { content: { type: "FUNCTION_CALL_START", detail: { toolUse: [{ id: "cloud-native-1", name, input: { text: "native argument" } }] } } },
  { content: { type: "FUNCTION_CALL_END", detail: { toolUse: [{ id: "cloud-native-1", name, input: {} }] } } },
  { content: { type: "ANSWER", detail: { end: true } } },
]
const encode = events => new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))
const sse = events => new Response(encode(events), { headers: { "content-type": "text/event-stream" } })
const imagePart = { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } }
async function fixture(handler = () => answer("ok"), options = {}) {
  const calls = []
  let identity = { type: "api", key: "account-a" }
  let id = 0
  const hooks = await ComateAuthPlugin({}, {
    ...options,
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).hostname, "comate.baidu.com")
      assert.equal(init.redirect, "error")
      const body = JSON.parse(init.body)
      calls.push({ url, body, signal: init.signal, license: init.headers["login-name"] })
      if (url.endsWith("/available")) return Response.json({ code: 0, data: [{ modelId: "vision", supportImage: true }] })
      if (url.endsWith("/upload")) return Response.json({ code: 200, data: { id: ++id, url: `https://comate.baidu.com/image/${id}` } })
      if (url.endsWith("/conversation")) return Response.json({ code: 0, data: { id: ++id } })
      if (url.endsWith("/task")) return Response.json({ code: 0, data: { taskId: ++id } })
      const value = await handler(body, calls)
      return value instanceof Response ? value : sse(value)
    },
  })
  const loader = await hooks.auth.loader(async () => identity)
  const request = (messages, extra = {}, session = "session-a") => loader.fetch("https://unused", {
    body: JSON.stringify({ model: "vision", messages, tools, ...extra }),
    headers: { "x-magpie-comate-session": session },
  })
  return { request, hooks, calls, switchAccount(key) { identity = { type: "api", key } }, executions: () => calls.filter(call => call.url.endsWith("/execute")) }
}
const message = async response => { assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).choices[0].message }

test("native tool results retain cloud ID, original parameters and stable aliases; next user reuses task", async () => {
  let step = 0
  const f = await fixture(body => step++ === 0 ? toolAnswer(body.tools[0].function.name) : answer("continued"))
  const messages = [user("call echo")]
  const first = await message(await f.request(messages))
  const call = first.tool_calls[0]
  messages.push(first, { role: "tool", tool_call_id: call.id, content: "actual client result", isError: true })
  const second = await message(await f.request(messages))
  const [a, b] = f.executions().map(call => call.body)
  assert.equal(a.conversationId, b.conversationId)
  assert.equal(a.taskId, b.taskId)
  assert.equal(b.isFirstQuery, false)
  assert.equal(b.isUserQuery, false)
  assert.equal(b.query, "")
  assert.deepEqual(b.toolUseResults, [{ id: "cloud-native-1", name: a.tools[0].function.name, params: { text: "native argument" }, success: false, message: "actual client result" }])
  assert.equal(a.tools[0].function.name, b.tools[0].function.name)
  messages.push(second, user("new user turn"))
  await message(await f.request(messages))
  const c = f.executions()[2].body
  assert.equal(c.taskId, a.taskId)
  assert.match(c.query, /new user turn/)
  assert.doesNotMatch(c.query, /actual client result/)
})

test("streaming native calls are correlated before their results return", async () => {
  let step = 0
  const f = await fixture(body => step++ === 0 ? toolAnswer(body.tools[0].function.name) : answer("done"))
  const messages = [user("call")]
  const stream = await (await f.request(messages, { stream: true })).text()
  const deltas = stream.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).flatMap(event => event.choices?.[0]?.delta?.tool_calls ?? [])
  const call = { ...deltas[0], function: { ...deltas[0].function, arguments: deltas.map(delta => delta.function.arguments ?? "").join("") } }
  messages.push({ role: "assistant", tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: "result" })
  await message(await f.request(messages))
  assert.equal(f.executions()[1].body.toolUseResults[0].id, "cloud-native-1")
})

test("account/model/session switches and history branches cannot share remote state", async () => {
  const f = await fixture()
  const initial = [user("one")], reply = await message(await f.request(initial))
  const continued = [...initial, reply, user("two")]
  await message(await f.request(continued))
  await message(await f.request([...initial, reply, user("separate")], {}, "other-session"))
  f.switchAccount("account-b")
  await message(await f.request(continued))
  await message(await f.request(continued, { model: "another-model" }))
  await message(await f.request([user("rewritten"), reply, user("two")]))
  const bodies = f.executions().map(call => call.body)
  assert.equal(bodies[0].conversationId, bodies[1].conversationId)
  assert.equal(new Set(bodies.slice(1).map(body => body.conversationId)).size, bodies.length - 1)
})

test("cache loss replays complete history including the orphaned tool result", async () => {
  const f = await fixture()
  await message(await f.request([user("original"), { role: "assistant", tool_calls: [{ id: "old-client-id", type: "function", function: { name: "echo", arguments: "{}" } }] }, { role: "tool", tool_call_id: "old-client-id", content: "orphaned actual result" }]))
  assert.equal(f.executions()[0].body.isFirstQuery, true)
  assert.match(f.executions()[0].body.query, /orphaned actual result/)
})

test("wrong or missing native result IDs fail before another execute and evict the failed state", async () => {
  const f = await fixture(body => toolAnswer(body.tools[0].function.name))
  const input = [user("call")], first = await message(await f.request(input))
  const failed = await f.request([...input, first, { role: "tool", tool_call_id: "wrong", content: "bad" }])
  assert.equal(failed.status, 502)
  assert.equal(f.executions().length, 1)
  await message(await f.request([...input, first, user("start over")]))
  assert.equal(f.executions()[1].body.isFirstQuery, true)
})

test("images upload separately, image-only input works, and continuation does not upload old images again", async () => {
  const f = await fixture()
  const input = [user([imagePart])]
  const first = await message(await f.request(input))
  const upload = f.calls.find(call => call.url.endsWith("/upload"))
  assert.equal(upload.body.fileData, "aW1hZ2U=")
  const execute = f.executions()[0].body
  assert.equal(execute.contexts[0].type, "IMAGE")
  assert.equal(execute.contexts[0].imageIds.length, 1)
  assert.doesNotMatch(execute.query, /aW1hZ2U=/)
  await message(await f.request([...input, first, user("what about it?")]))
  assert.equal(f.calls.filter(call => call.url.endsWith("/upload")).length, 1)
  assert.deepEqual(f.executions()[1].body.contexts, [])
  const models = await f.hooks.provider.models({ id: "comate", models: {} }, { auth: { type: "api", key: "account-a" } })
  assert.equal(models.vision.capabilities.input.image, true)
})

test("native image tool results are inline and preserve user text sent during execution", async () => {
  let step = 0
  const f = await fixture(body => step++ === 0 ? toolAnswer(body.tools[0].function.name) : answer("seen"))
  const input = [user("read image")], first = await message(await f.request(input))
  await message(await f.request([...input, first, { role: "tool", tool_call_id: first.tool_calls[0].id, content: [{ type: "text", text: "image output" }, imagePart] }, user("also describe it")]))
  assert.equal(f.calls.filter(call => call.url.endsWith("/upload")).length, 0)
  const body = f.executions()[1].body
  assert.equal(body.toolUseResults[0].result.source.data, "aW1hZ2U=")
  assert.equal(body.isUserQuery, true)
  assert.match(body.query, /also describe it/)
})

for (const part of [imagePart, { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } }]) test(`inline image form ${part.type} is supported`, () => {
  assert.equal(normalizeMessages([user([part])]).images.get(0)[0].data, "aW1hZ2U=")
})
for (const part of [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }, { type: "input_image", image_url: "data:image/png;base64,%%%=" }, { type: "document", source: {} }]) test(`invalid input is rejected before cloud I/O: ${part.type}`, async () => {
  const f = await fixture(); assert.equal((await f.request([user([part])])).status, 400); assert.equal(f.calls.length, 0)
})
test("image count and decoded size are bounded with explicit errors", async () => {
  const f = await fixture()
  assert.equal((await f.request([user(Array(6).fill(imagePart))])).status, 400)
  const oversized = { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.alloc(IMAGE_MAX_BYTES + 1).toString("base64") } }
  assert.equal((await f.request([user([oversized])])).status, 400)
  assert.equal(f.executions().length, 0)
})

test("continuous activity passes ten minutes without a total turn timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let upstream
  const f = await fixture(() => new Response(new ReadableStream({ start(controller) { upstream = controller } }), { headers: { "content-type": "text/event-stream" } }))
  const response = await f.request([user("long task")], { stream: true })
  const reader = response.body.getReader()
  await reader.read() // assistant role
  let output = ""
  for (let minute = 0; minute < 10; minute++) {
    const read = reader.read()
    await nextTick()
    t.mock.timers.tick(60_000)
    upstream.enqueue(encode([{ content: { type: "ANSWER", detail: { delta: `minute ${minute}\n` } } }]))
    output += new TextDecoder().decode((await read).value)
  }
  upstream.enqueue(encode(answer("done")))
  upstream.close()
  for (;;) { const next = await reader.read(); if (next.done) break; output += new TextDecoder().decode(next.value) }
  assert.match(output, /minute 9/)
  assert.match(output, /"finish_reason":"stop"/)
  assert.doesNotMatch(output, /"error"/)
})

test("a silent stream still fails on idle deadline and releases the session", async () => {
  let step = 0
  const f = await fixture(() => step++ === 0 ? new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }) : answer("recovered"), { streamIdle: { firstMs: 20, idleMs: 20 } })
  const bad = await f.request([user("silent")])
  assert.equal(bad.status, 502)
  assert.match(await bad.text(), /idle/)
  assert.equal((await f.request([user("recovered")])).status, 200)
})

test("concurrent requests for the same session return 409 until cancel; different sessions remain independent", async () => {
  const f = await fixture(() => new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }))
  const first = await f.request([user("active")], { stream: true })
  assert.equal((await f.request([user("collision")])).status, 409)
  const independent = await f.request([user("other")], { stream: true }, "other")
  assert.equal(independent.status, 200)
  await first.body.cancel()
  await independent.body.cancel()
  const resumed = await f.request([user("retry")], { stream: true })
  assert.equal(resumed.status, 200)
  await resumed.body.cancel()
})

test("upload failure never submits an execute or contacts a desktop service", async () => {
  const calls = []
  const hooks = await ComateAuthPlugin({}, { fetchImpl: async (url, init) => {
    calls.push(url)
    if (url.endsWith("/conversation")) return Response.json({ code: 0, data: { id: 1 } })
    if (url.endsWith("/task")) return Response.json({ code: 0, data: { taskId: 2 } })
    return new Response("upload refused", { status: 500 })
  } })
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "fake" }))
  const response = await loader.fetch("https://unused", { body: JSON.stringify({ model: "vision", messages: [user([imagePart])] }) })
  assert.equal(response.status, 502)
  assert.ok(calls.every(url => new URL(url).hostname === "comate.baidu.com"))
  assert.equal(calls.filter(url => url.endsWith("/execute")).length, 0)
})

test("native stream failure invalidates state; next attempt starts a new task", async () => {
  let step = 0
  const f = await fixture(() => ++step === 2 ? [{ content: { type: "EXCEPTION" } }] : answer("ok"))
  const initial = [user("one")], first = await message(await f.request(initial))
  const next = [...initial, first, user("two")]
  assert.equal((await f.request(next)).status, 502)
  await message(await f.request(next))
  const bodies = f.executions().map(call => call.body)
  assert.equal(bodies[0].taskId, bodies[1].taskId)
  assert.notEqual(bodies[1].taskId, bodies[2].taskId)
  assert.equal(bodies[2].isFirstQuery, true)
})

test("missed turns and a changed tool catalog trigger full replay", async () => {
  const f = await fixture(), input = [user("one")], first = await message(await f.request(input))
  const branch = [...input, first, user("intermediate"), { role: "assistant", content: "answer from another client" }, user("latest")]
  await message(await f.request(branch))
  assert.equal(f.executions()[1].body.isFirstQuery, true)
  assert.match(f.executions()[1].body.query, /answer from another client/)
  await message(await f.request([...branch, { role: "assistant", content: "ok" }, user("new tools")], { tools: [] }))
  assert.equal(f.executions()[2].body.isFirstQuery, true)
})

test("text-shaped objects cannot silently hide unsupported image or source fields", async () => {
  const f = await fixture()
  assert.equal((await f.request([user({ text: "text", image_url: "https://example.com/image.png" })])).status, 400)
  assert.equal(f.calls.length, 0)
})

test("a null upload ID cannot be accepted as image zero", async () => {
  let executes = 0
  const hooks = await ComateAuthPlugin({}, { fetchImpl: async url => {
    if (url.endsWith("/conversation")) return Response.json({ code: 0, data: { id: 1 } })
    if (url.endsWith("/task")) return Response.json({ code: 0, data: { taskId: 2 } })
    if (url.endsWith("/execute")) executes++
    return Response.json({ code: 200, data: { id: null } })
  } })
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "fake" }))
  const response = await loader.fetch("https://unused", { body: JSON.stringify({ model: "vision", messages: [user([imagePart])] }) })
  assert.equal(response.status, 502)
  assert.equal(executes, 0)
})
