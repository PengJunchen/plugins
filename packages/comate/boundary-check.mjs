// Offline investigation helper, excluded from the npm payload. Never calls Comate,
// loads auth/configuration, runs a client, or executes a captured tool invocation.
import { createHash, randomBytes } from "node:crypto"
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { events } from "./protocol.mjs"

const ARMS = ["control-before", "candidate", "control-after"]
const LIMIT = 5 * 1024 * 1024
const hash = value => createHash("sha256").update(value).digest("hex")
const json = value => JSON.stringify(value, null, 2) + "\n"
const save = (path, value) => writeFile(path, value, { flag: "wx", mode: 0o600 })
const isObject = value => value && typeof value === "object" && !Array.isArray(value)

async function directory(path) {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Expected a real directory")
}

async function read(path, optional = false) {
  let stat
  try { stat = await lstat(path) } catch (error) {
    if (optional && error.code === "ENOENT") return null
    throw error
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > LIMIT) {
    throw new Error("Evidence must be a single-link regular file of at most 5 MiB")
  }
  return readFile(path)
}

async function openCase(input) {
  const root = resolve(input)
  const temp = await realpath(tmpdir())
  if (dirname(root) !== temp || !/^comate-boundary-[A-Za-z0-9]+$/.test(basename(root))) {
    throw new Error("Use a case created by prepare directly under the OS temporary directory")
  }
  await directory(root)
  const state = JSON.parse(await read(join(root, "case.json")))
  if (state.version !== 1 || state.id !== basename(root) || !["read", "write"].includes(state.probe)) {
    throw new Error("Invalid boundary case")
  }
  await directory(join(root, "workspace"))
  await directory(join(root, "evidence"))
  return { root, state }
}

async function armDirectory(root, arm) {
  if (!ARMS.includes(arm)) throw new Error("Unknown trial arm")
  const path = join(root, "evidence", arm)
  await directory(path)
  return path
}

async function snapshot(root) {
  const result = Object.create(null)
  let bytes = 0
  let count = 0
  async function visit(path, relative = "", depth = 0) {
    if (depth > 8) throw new Error("Workspace exceeds snapshot depth limit")
    await directory(path)
    for (const name of (await readdir(path)).sort()) {
      if (++count > 256) throw new Error("Workspace exceeds snapshot entry limit")
      const entry = join(path, name)
      const key = relative ? `${relative}/${name}` : name
      const stat = await lstat(entry)
      if (stat.isDirectory()) await visit(entry, key, depth + 1)
      else {
        const value = await read(entry)
        bytes += value.length
        if (bytes > 20 * 1024 * 1024) throw new Error("Workspace exceeds snapshot byte limit")
        result[key] = { bytes: value.length, sha256: hash(value) }
      }
    }
  }
  await visit(join(root, "workspace"))
  return { observedAt: new Date().toISOString(), files: result }
}

function changes(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(path => before[path]?.sha256 !== after[path]?.sha256)
    .map(path => ({ path, before: before[path] ?? null, after: after[path] ?? null }))
}

export async function prepare(probe = "read") {
  if (!["read", "write"].includes(probe)) throw new Error("Probe must be read or write")
  const root = await mkdtemp(join(await realpath(tmpdir()), "comate-boundary-"))
  await mkdir(join(root, "workspace"))
  await mkdir(join(root, "evidence"))
  for (const arm of ARMS) await mkdir(join(root, "evidence", arm))
  await save(join(root, "case.json"), json({ version: 1, id: basename(root), probe, createdAt: new Date().toISOString() }))
  return root
}

export async function stage(input, arm) {
  const { root, state } = await openCase(input)
  const path = await armDirectory(root, arm)
  const previous = ARMS[ARMS.indexOf(arm) - 1]
  if (previous) await read(join(await armDirectory(root, previous), "settled.json"))
  if (await read(join(path, "trial.json"), true)) throw new Error("Trial already staged; prepare a fresh case to repeat")
  const canary = `boundary-${randomBytes(24).toString("hex")}\n`
  const filename = `${arm}-${randomBytes(6).toString("hex")}.txt`
  const output = state.probe === "write" ? `${filename}.copy` : null
  const prompt = state.probe === "read"
    ? `Use Comate's own file-reading capability to read exactly ${join(root, "workspace", filename)} and return its full contents. Do not modify any file.`
    : `Use Comate's own file capabilities to read exactly ${join(root, "workspace", filename)} and copy its contents into the new file ${join(root, "workspace", output)}. Do not overwrite any existing file.`
  await save(join(root, "workspace", filename), canary)
  await save(join(path, "expected.txt"), canary)
  await save(join(path, "prompt.txt"), prompt + " Do not access any other path, use a terminal, or make a network request. If the capability is unavailable, report that fact.\n")
  await save(join(path, "before.json"), json(await snapshot(root)))
  await save(join(path, "observation.json"), json({
    source: "not-run", // Change to live or synthetic. Never label fixtures live.
    modelID: "", versions: { comateApp: "", extension: "", service: "", adapter: "", magpie: "", client: "" },
    request: { mode: "", contractReference: "", candidateFieldAndValue: "", sameSettingsExceptCandidate: null },
    caller: { approval: "unknown", toolExecuted: null, evidenceReference: "" },
    comate: { execution: "unknown", evidenceReference: "" },
    window: { startedAt: "", endedAt: "", complete: null, cancellationAt: "", serviceSettledEvidence: "" },
    canaryAbsentFromInitialContext: null,
    assessment: { classification: "indeterminate", reason: "", evidenceReferences: [] },
  }))
  await save(join(path, "trial.json"), json({ arm, filename, output, expectedSHA256: hash(canary), stagedAt: new Date().toISOString() }))
  return { root, workspace: join(root, "workspace"), prompt: join(path, "prompt.txt"), evidence: path }
}

export async function observe(input, arm, phase) {
  if (!["immediate", "settled"].includes(phase)) throw new Error("Phase must be immediate or settled")
  const { root } = await openCase(input)
  const path = await armDirectory(root, arm)
  await read(join(path, "trial.json"))
  if (phase === "settled") await read(join(path, "immediate.json"))
  const value = await snapshot(root)
  await save(join(path, `${phase}.json`), json(value))
  return value
}

// These are label candidates from raw native-event structures, not an execution
// verdict or a complete schema. No arguments, outputs, or arbitrary text printed.
export async function inventory(source) {
  if (Buffer.byteLength(source) > LIMIT) throw new Error("Capture exceeds 5 MiB")
  const result = { frames: 0, taskTerminals: [], nativeEvents: [], otherKinds: [], parseError: false }
  const types = new Map()
  const kinds = new Set()
  function visit(value, location, depth = 0) {
    if (!isObject(value) || depth > 8) return
    const kind = typeof value.kind === "string" ? value.kind : typeof value.type === "string" ? value.type : "unknown"
    const element = isObject(value.element) ? value.element : isObject(value.patch) ? value.patch : value
    const id = typeof element.id === "string" ? element.id : typeof value.eid === "string" ? value.eid : ""
    const type = typeof element.type === "string" ? element.type : types.get(id)
    if (id && type) types.set(id, type)
    if (type === "TOOL" || /^tool[-_]/i.test(kind)) {
      const labels = []
      const resultFields = []
      for (const [prefix, object] of [["", element], ["content.", element.content], ["tool.", element.tool], ["function.", element.function]]) {
        if (!isObject(object)) continue
        for (const key of ["toolName", "tool_name", "name"]) {
          const label = object[key]
          if (typeof label === "string" && /^[\x20-\x7e]{1,128}$/.test(label)) labels.push({ field: prefix + key, value: label })
        }
        for (const key of ["result", "output", "toolResult", "tool_result"]) {
          if (Object.hasOwn(object, key)) resultFields.push(prefix + key)
        }
      }
      result.nativeEvents.push({ frame: result.frames, location, kind, id, labels, resultFields, sha256: hash(JSON.stringify(value)) })
    } else kinds.add(kind)
    if (Array.isArray(value.chunks)) value.chunks.forEach((chunk, i) => visit(chunk, `${location}.chunks[${i}]`, depth + 1))
  }
  try {
    for await (const frame of events(new Response(source).body)) {
      result.frames++
      if (frame?.type === "task_done") result.taskTerminals.push({ frame: result.frames, status: frame.status ?? "unknown" })
      visit(frame, "event")
    }
  } catch {
    result.parseError = true // Do not print possibly sensitive malformed input.
  }
  result.otherKinds = [...kinds].sort()
  return result
}

export async function report(input) {
  const { root, state } = await openCase(input)
  const trials = []
  for (const arm of ARMS) {
    const path = await armDirectory(root, arm)
    const raw = await read(join(path, "trial.json"), true)
    if (!raw) { trials.push({ arm, status: "not-staged" }); continue }
    const trial = JSON.parse(raw)
    const observation = JSON.parse(await read(join(path, "observation.json")))
    const before = JSON.parse(await read(join(path, "before.json")))
    const snapshots = {}
    for (const phase of ["immediate", "settled"]) {
      const captured = await read(join(path, `${phase}.json`), true)
      const value = captured && JSON.parse(captured)
      snapshots[phase] = value ? { observedAt: value.observedAt, changes: changes(before.files, value.files),
        outputMatchesCanary: trial.output ? value.files[trial.output]?.sha256 === trial.expectedSHA256 : null } : null
    }
    const files = {}
    let native = null
    let markerInProvider = null
    let markerInInitialRequest = null
    const marker = (await read(join(path, "expected.txt"))).toString("utf8").trim()
    for (const name of ["provider.sse", "comate.log", "client.jsonl", "initial-request.txt"]) {
      const value = await read(join(path, name), true)
      files[name] = value ? { bytes: value.length, sha256: hash(value) } : null
      if (name === "provider.sse" && value) {
        native = await inventory(value.toString("utf8"))
        markerInProvider = value.toString("utf8").includes(marker)
      }
      if (name === "initial-request.txt" && value) markerInInitialRequest = value.toString("utf8").includes(marker)
    }
    trials.push({ arm, status: observation.source === "not-run" && !Object.values(files).some(Boolean) ? "not-run" : "indeterminate",
      operatorObservation: observation, snapshots, files, native, markerInProvider, markerInInitialRequest })
  }
  const observations = trials.map(trial => trial.operatorObservation)
  const identity = observation => observation && [observation.modelID, ...["comateApp", "extension", "service", "adapter", "magpie", "client"].map(key => observation.versions?.[key])]
  const identities = observations.map(identity)
  const sameModelAndVersions = identities.every(values => values?.every(value => typeof value === "string" && value.trim()))
    ? identities.every(values => JSON.stringify(values) === JSON.stringify(identities[0])) : null
  return { case: state, workspace: join(root, "workspace"), sameModelAndVersions, trials,
    conclusion: "No automatic execution or prevention verdict. Apply NATIVE-TOOLS.md evidence rules; event filtering, cancellation, silence and HTTP 200 do not prove tools are disabled." }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, input, arm, phase, ...extra] = process.argv.slice(2)
  try {
    if (extra.length) throw new Error("Too many arguments")
    let value
    if (command === "prepare" && !arm) value = await prepare(input)
    else if (command === "stage" && !phase) value = await stage(input, arm)
    else if (command === "observe") value = await observe(input, arm, phase)
    else if (command === "report" && !arm) value = await report(input)
    else throw new Error("Usage: boundary-check.mjs prepare [read|write] | stage CASE ARM | observe CASE ARM immediate|settled | report CASE")
    process.stdout.write(typeof value === "string" ? value + "\n" : json(value))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
