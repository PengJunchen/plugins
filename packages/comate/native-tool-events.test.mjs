import test from "node:test"
import assert from "node:assert/strict"
import { piecesOf, newState, consumeComateSSE, comatePieces } from "./protocol.mjs"

test("native TOOL additions and patches fail without relying on string content", () => {
  for (const content of [undefined, "", { command: "not executed by this fixture" }]) {
    const element = { id: "native", type: "TOOL", ...(content === undefined ? {} : { content }) }
    assert.throws(() => piecesOf({ kind: "element-add", element }, newState()), /native TOOL/)
    assert.throws(() => piecesOf({ kind: "element-patch", eid: "native", patch: element }, newState()), /native TOOL/)
  }
  const state = newState()
  state.types.set("native", "TOOL")
  assert.throws(() => piecesOf({ kind: "element-patch", eid: "native", patch: { done: true } }, state), /native TOOL/)
})

test("structured native tools cannot disappear before a completed task in either SSE consumer", async () => {
  const frames = [
    { kind: "delta-batch", chunks: [{ kind: "element-add", element: { id: "native", type: "TOOL", toolName: "Read", content: { file_path: "fixture.txt" } } }] },
    { kind: "text-delta", eid: "answer", delta: "unverified answer" },
    { type: "task_done", status: "completed" },
  ]
  const body = () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")).body
  await assert.rejects(consumeComateSSE(body()), /native TOOL/)
  await assert.rejects(async () => {
    for await (const _ of comatePieces(body())) assert.fail("native tool must fail before answer text")
  }, /native TOOL/)
})
