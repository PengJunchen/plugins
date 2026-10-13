import assert from "node:assert/strict"
import { link, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { inventory, observe, prepare, report, stage } from "./boundary-check.mjs"
import { _internal } from "./index.mjs"

const sse = frames => frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")
const terminal = { type: "task_done", status: "completed" }
const native = { kind: "element-add", element: { id: "fixture-native", type: "TOOL", toolName: "fixture_copy" } }

async function setup(t, probe) {
  const root = await prepare(probe)
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, ...(await stage(root, "control-before")) }
}

test("offline cases have fresh canaries absent from prompts, ordered trials and no live verdict", async t => {
  const { root, workspace, evidence, prompt } = await setup(t)
  const marker = (await readFile(join(evidence, "expected.txt"), "utf8")).trim()
  assert.ok(!(await readFile(prompt, "utf8")).includes(marker))
  const trial = JSON.parse(await readFile(join(evidence, "trial.json")))
  assert.equal((await readFile(join(workspace, trial.filename), "utf8")).trim(), marker)
  await assert.rejects(stage(root, "candidate"), /ENOENT/)
  await assert.rejects(stage(root, "control-before"), /already staged/)
  await observe(root, "control-before", "immediate")
  await observe(root, "control-before", "settled")
  const candidate = await stage(root, "candidate")
  assert.equal(candidate.workspace, workspace)
  assert.notEqual(await readFile(join(candidate.evidence, "expected.txt"), "utf8"), marker + "\n")
  const result = await report(root)
  assert.equal(result.sameModelAndVersions, null)
  assert.equal(result.trials[0].status, "not-run")
  assert.equal(result.trials[0].snapshots.settled.outputMatchesCanary, null)
  assert.deepEqual(result.trials[0].snapshots.settled.changes, [])
  await assert.rejects(observe(root, "control-before", "settled"), /EEXIST/)
})

test("inventory retains raw TOOL adds, patches and result markers without printing content", async () => {
  const result = await inventory(sse([
    { kind: "delta-batch", chunks: [native, { kind: "element-patch", eid: "fixture-native", patch: { result: "private fixture content" } }] },
    { kind: "tool-result", toolName: "fixture_search", output: "private fixture content" }, terminal,
  ]))
  assert.equal(result.nativeEvents.length, 3)
  assert.deepEqual(result.nativeEvents[0].labels, [{ field: "toolName", value: "fixture_copy" }])
  assert.deepEqual(result.nativeEvents[1].labels, [])
  assert.deepEqual(result.nativeEvents[1].resultFields, ["result"])
  assert.equal(result.taskTerminals[0].status, "completed")
  assert.ok(!JSON.stringify(result).includes("private fixture content"))
})

test("missing names, unfamiliar events and truncated or malformed captures remain observable", async () => {
  const unknown = await inventory(sse([{ kind: "new-shape", nested: { toolName: "not inferred" } },
    { kind: "element-add", element: { id: "unknown", type: "TOOL", content: "not a structured name" } }]))
  assert.deepEqual(unknown.nativeEvents[0].labels, [])
  assert.ok(unknown.otherKinds.includes("new-shape"))
  assert.deepEqual(unknown.taskTerminals, [])
  assert.equal((await inventory('data: {"kind":"tool-call"\n\n')).parseError, true)
  assert.equal((await inventory(sse([terminal]) + 'data: {bad\n\n')).parseError, true)
  const textOnly = await inventory(await readFile(new URL("./protocol-live-text.sse", import.meta.url), "utf8"))
  assert.equal(textOnly.nativeEvents.length, 0)
  await assert.rejects(inventory("x".repeat(5 * 1024 * 1024 + 1)), /5 MiB/)
})

test("file effects before an event and after cancellation remain separate from event rejection (synthetic)", async t => {
  const { root, workspace, evidence } = await setup(t, "write")
  const trial = JSON.parse(await readFile(join(evidence, "trial.json")))
  const canary = await readFile(join(evidence, "expected.txt"))
  let cancelled = false
  const factory = _internal.createPlugin({ discoveryOptions: { port: 8627 }, fetchImpl: async url => {
    if (String(url).endsWith("/init")) {
      // Deliberately model an effect before the adapter sees the native event.
      await writeFile(join(workspace, trial.output), canary, { flag: "wx" })
      return new Response(sse([native, terminal]), { headers: { "content-type": "text/event-stream" } })
    }
    assert.ok(String(url).endsWith("/cancel"))
    cancelled = true
    return new Response(null, { status: 200 })
  } })
  const plugin = await factory({})
  const auth = await plugin.auth.loader(async () => ({ type: "api", source: "comate-paste", key: "synthetic-test-credential", port: 8627 }))
  const response = await auth.fetch("http://127.0.0.1:8627/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "fixture-model", stream: false, messages: [{ role: "user", content: "synthetic probe" }] }),
  })
  assert.equal(response.status, 502)
  assert.match(await response.text(), /native TOOL/)
  assert.equal(cancelled, true)
  await observe(root, "control-before", "immediate")
  await writeFile(join(workspace, "late-fixture.txt"), "synthetic late effect", { flag: "wx" })
  await observe(root, "control-before", "settled")
  await writeFile(join(evidence, "provider.sse"), sse([native, terminal]))
  const observation = JSON.parse(await readFile(join(evidence, "observation.json")))
  observation.source = "synthetic"
  await writeFile(join(evidence, "observation.json"), JSON.stringify(observation))
  const result = (await report(root)).trials[0]
  assert.equal(result.status, "indeterminate")
  assert.equal(result.snapshots.immediate.outputMatchesCanary, true)
  assert.equal(result.snapshots.settled.changes.length, 2)
  assert.equal(result.operatorObservation.caller.approval, "unknown")
  assert.equal(result.operatorObservation.source, "synthetic")
})

test("HTTP acceptance, output canaries and operator assertions do not become a prevention verdict", async t => {
  const { root } = await setup(t)
  for (const arm of ["control-before", "candidate", "control-after"]) {
    if (arm !== "control-before") await stage(root, arm)
    const path = join(root, "evidence", arm)
    const observation = JSON.parse(await readFile(join(path, "observation.json")))
    observation.source = "synthetic"
    observation.modelID = "fixture-model"
    for (const key of Object.keys(observation.versions)) observation.versions[key] = "fixture-version"
    observation.request.candidateFieldAndValue = arm === "candidate" ? "unverified_flag=true (HTTP 200)" : ""
    observation.assessment.classification = "blocked-before-execution"
    await writeFile(join(path, "observation.json"), JSON.stringify(observation))
    const marker = await readFile(join(path, "expected.txt"), "utf8")
    await writeFile(join(path, "provider.sse"), sse([{ kind: "text-delta", delta: marker }, terminal]))
    await writeFile(join(path, "initial-request.txt"), marker)
    await observe(root, arm, "immediate")
    await observe(root, arm, "settled")
  }
  const result = await report(root)
  assert.equal(result.sameModelAndVersions, true)
  assert.equal(result.trials[1].markerInProvider, true)
  assert.equal(result.trials[1].markerInInitialRequest, true)
  assert.equal(result.trials[1].status, "indeterminate")
  const path = join(root, "evidence", "candidate", "observation.json")
  const observation = JSON.parse(await readFile(path))
  observation.versions.service = "different-fixture-version"
  await writeFile(path, JSON.stringify(observation))
  assert.equal((await report(root)).sameModelAndVersions, false)
})

test("helper refuses arbitrary roots, path traversal, symlinks and hard links", async t => {
  const { root, workspace, evidence } = await setup(t)
  await assert.rejects(report(workspace), /case created by prepare/)
  await assert.rejects(stage(root, "../workspace"), /Unknown trial/)
  const external = join(root, "unrelated-fixture.txt")
  await writeFile(external, "nonsensitive fixture")
  await symlink(external, join(evidence, "provider.sse"))
  await assert.rejects(report(root), /single-link regular file/)
  await rm(join(evidence, "provider.sse"))
  await link(external, join(workspace, "linked.txt"))
  await assert.rejects(observe(root, "control-before", "immediate"), /single-link regular file/)
  await rm(join(workspace, "linked.txt"))
  await symlink(evidence, join(workspace, "linked-directory"), "dir")
  await assert.rejects(observe(root, "control-before", "immediate"), /single-link regular file/)
})
