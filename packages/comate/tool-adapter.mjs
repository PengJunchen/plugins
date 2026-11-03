// Adapt a vendor directory-list request only when the caller offers a
// compatible shell tool. Never execute it here or widen caller permissions.
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'"

export function clientToolCall(call, spec) {
  if (!spec.enabled) throw new Error(`Comate requested a tool the client did not offer: ${call.name}`)
  if (spec.byName.has(call.name)) return { name: call.name, input: call.input }
  if (call.name !== "list_dir") throw new Error(`Comate requested a tool the client did not offer: ${call.name}`)
  const allowed = new Set(["target_directory", "path", "directory", "depth", "explanation"])
  if (Object.keys(call.input).some(key => !allowed.has(key))) throw new Error("Comate list_dir contains unsupported options: " + Object.entries(call.input).map(([key,value])=>key+":"+typeof value).join(", "))
  const paths = [call.input.target_directory, call.input.path, call.input.directory].filter(value => value !== undefined)
  if (paths.some(value => typeof value !== "string" || !value.trim() || value.includes("\0")) || new Set(paths).size > 1) throw new Error("Comate list_dir contains an invalid or ambiguous directory")
  const path = paths[0] ?? "."
  const rawDepth = call.input.depth ?? 1
  const depth = typeof rawDepth === "number" ? rawDepth : typeof rawDepth === "string" && /^\d+$/.test(rawDepth) ? Number(rawDepth) : NaN
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 64) throw new Error("Comate list_dir depth must be an integer from 1 to 64")
  const operand = path.startsWith("/") || path.startsWith("./") || path.startsWith("../") || path === "." || path === ".." ? path : "./" + path
  const command = depth === 1 ? `ls -la -- ${quote(path)}` : `find ${quote(operand)} -mindepth 1 -maxdepth ${depth} -print`
  for (const tool of spec.tools) {
    const name = spec.byName.get(tool.function.name)
    if (!["bash", "Bash"].includes(name)) continue
    const schema = tool.function.parameters, props = schema?.properties
    if (props?.command?.type !== "string") continue
    const input = { command }
    if (props.description?.type === "string") input.description = depth === 1 ? "List immediate directory entries including hidden files" : "List directory entries to the requested depth"
    if ((schema.required ?? []).some(key => !Object.hasOwn(input, key))) continue
    return { name, input }
  }
  throw new Error("Comate requested list_dir, but the client offers no compatible directory-list or bash tool")
}
