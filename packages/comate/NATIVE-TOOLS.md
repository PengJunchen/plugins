# Native Comate tools: investigation and isolated test procedure

Status on 2026-10-13: **unresolved; no verified tools-off or read-only boundary
for the plugin's local HTTP path**. No adapter behavior changes accompany this
investigation. The plugin stays a draft, outside the market. This addresses the
evidence requested in [the latest review](https://github.com/magpie-community/plugins/pull/77#issuecomment-6135762797);
it does not replace the separate [real-client acceptance record](./VALIDATION.md).

## Evidence available now

| Item | Evidence and limit |
| --- | --- |
| Native tool names | The public PR and review explicitly name `read_file` in `claude-preface-04-kimik3` (model `comate/kimi-k3_3d357a70771545b8a7621793974a2539`, runtime `a9b92c9`). Other attempts mention native TOOL events without names. The original native captures are not in this checkout; the full inventory remains open. |
| Actual native execution | No correlated Comate execution logs or before/after file observations for those attempts are available here. A TOOL event may describe intent, progress or a completed action. Its presence alone cannot settle execution. |
| Client tool names | `Read` and `exec_command` in the successful real-client records are calling-client tools. They are not additional observed native Comate tool names. |
| Fixtures | `native-tool-events.test.mjs` uses `Read` and a `command` property in synthetic events. `protocol.test.mjs` includes an adversarial `read_file` string. These are not captured names. The new diagnostic tests use `fixture_copy` and `fixture_search`. |
| Repository capture | `protocol-live-text.sse` has one TEXT element and a completed task. It contains no native TOOL event, result or execution log. |

The cloud environment has Codex CLI and Claude Code executables but no signed-in
Comate desktop service or authorized desktop access. Neither user's local
computer is available/authorized for this task. No new live native-tool or
real-client boundary run was performed, and no login material was inspected or
transferred. Existing first-turn client successes do not prove native-tool
containment; same-session follow-up failures remain recorded.

## Request contract and official documentation

The adapter currently posts `query`, `license`, `model`, `modelId`, `traceId`,
`mode: "Ask"` and `enableCodebaseSearch: false` to
`/api/v1/conversations/init`. Only `query` carries the emulated client tools and
tool-choice instructions. Client `tool_choice: "none"` is not a native-tools
permission field. Turning codebase search off does not establish a general
native-tools prohibition.

The raw SSE parser can expose events, but the adapter's consumers reject native
TOOL elements and request cancellation after receiving them. Cancellation uses
the trace ID and is best effort; the adapter does not verify a dispatcher denial
or roll back effects. A 502, stream error, disconnected reader, or successful
cancel response is not evidence of prevention.

Official sources inspected on 2026-10-13:

| Source | What it establishes; what remains unknown |
| --- | --- |
| [IDE modes](https://cloud.baidu.com/doc/COMATE/s/1msoequh2), updated 2026-08-14 | Describes Ask as read-only exploration, without automatic modification, with search tools enabled. This is evidence of intended IDE behavior, not tools-off. It does not specify the local HTTP schema or prove that desktop service 1.8.1 dispatches this plugin request with that restriction. |
| [CLI quick start](https://cloud.baidu.com/doc/COMATE/s/0mrcv8nsa), updated 2026-07-09 | Documents `comatecli run`, `--mode`, `--cwd`, `--enable-codebase-search`, and separate switches for disabling built-in skills/hooks. The listed switches include no universal tools-off option. This is not proof that no such option exists in another version or interface. A skill/hook switch does not disable all tools. |
| [IDE settings](https://cloud.baidu.com/doc/COMATE/s/Hmspwpinv), updated 2026-08-12 | Describes terminal execution policies and separate MCP/browser policies. Record existing settings locally; do not assume terminal approval covers file/search tools or the HTTP service. Do not weaken these settings for a test. |
| [Export IDE logs](https://cloud.baidu.com/doc/COMATE/s/5mssk7eis), updated 2026-08-14 | Explains the IDE toolbar's log export and local reveal action. It does not promise a particular execution/denial log schema. Inspect locally and share only a small redacted excerpt for the trial; do not upload the full archive. |

Next contract evidence must come from the exact installed service's help,
schema, source or vendor documentation: the native dispatcher tool set for Ask,
the meaning of any proposed disable field, and how this HTTP request reaches
that dispatcher. An unknown JSON field accepted with HTTP 200 is not validation.
Do not invent a `tools: []` or similar field and advertise it as a control.

## Recover the existing evidence first

On an authorized machine, find the original `claude-preface-04-kimik3` capture
and the other attempts reporting native TOOL. Record the exact model ID,
Comate/app/extension/service versions and adapter revision for each attempt.
Keep trace, conversation, element and tool-call IDs consistently pseudonymized
across request, raw provider SSE, client events and Comate logs.

For each native event, retain its type, explicit tool-name field, timestamp,
argument *paths within the scratch directory*, status and result/denial fields.
Distinguish scheduled/start/result/denied events. Do not infer names from model
prose, prompt tool declarations or these tests' fixtures. If no explicit name is
available, record `unknown`. Include every relevant event, not only a successful
retry. Logs that merely repeat the prompt or tool request do not prove execution.

Check existing scratch-file evidence and Comate logs for those same IDs. Reads
usually leave no file diff; absence of changes cannot establish that a read did
not occur. If historical snapshots/logs do not exist, classify the attempt as
indeterminate instead of reconstructing a clean state after the fact.

## Offline helper and authorized local procedure

`boundary-check.mjs` prepares random, nonsensitive canaries; inventories supplied
raw SSE before adapter filtering; and hashes scratch files and supplied evidence.
It never calls a service, discovers credentials, runs a client, executes captured
commands, changes settings or deletes a case. It is excluded from npm. A temporary
folder and a restrictive prompt are **not an OS sandbox**. Its path/link/size
checks guard ordinary operator mistakes, not a concurrent hostile process.

1. Have the local operator/coordinator confirm an authorized isolated Comate
   workspace with no real project, indexed private files or secrets in context.
   Record existing approval/sandbox settings. Stop if safe isolation requires an
   unapproved account, machine, configuration or sandbox change. Do not use delete,
   shell, network, permission-changing or private-file probes.
2. Record exact model ID and every version. Use a fresh conversation for each
   trial, the same model, versions, workspace and request options, changing only
   the documented candidate field/mode. Do not silently switch from the desktop
   service to a different CLI backend. Do not upgrade or sign in for this test
   without local coordination.
3. From this source checkout, prepare and stage a read case (Node 22+):

   ```sh
   node packages/comate/boundary-check.mjs prepare read
   # Copy the printed absolute path as CASE in subsequent commands.
   node packages/comate/boundary-check.mjs stage CASE control-before
   ```

   `workspace/` is the only permitted probe directory. `evidence/control-before/`
   contains a prompt and an observation template; the random canary content is
   absent from the prompt. Do not attach the canary, expected file, evidence
   directory, previous results or case metadata to the request. Inspect the
   actual initial context locally to exclude accidental inclusion/indexing.
4. With the existing authorized capture harness, submit the staged prompt using
   the recorded request settings. Capture raw provider SSE *before* the adapter
   aborts on TOOL, Comate's own correlated execution/denial logs, and the caller's
   approvals and tool results separately. If the client executes the read, the
   returned canary cannot independently prove that Comate read it. Leave existing
   client protections in place; never bypass a denied client approval.
5. Immediately after the response/error/cancel, and again after the service has
   demonstrably settled, snapshot the workspace:

   ```sh
   node packages/comate/boundary-check.mjs observe CASE control-before immediate
   # Check the service's task/log state locally; record timestamps and evidence.
   node packages/comate/boundary-check.mjs observe CASE control-before settled
   ```

   A fixed wait alone does not prove quiescence. If the task cannot be tracked to
   a settled state, mark the observation window incomplete. This helper snapshots
   only its workspace; unchanged hashes do not exclude effects elsewhere. Keep
   other writers out of the directory while measuring.
6. Save **sanitized** evidence in that trial directory as `provider.sse`,
   `comate.log`, `client.jsonl` and `initial-request.txt` (request text/context,
   without license/headers). These are optional inputs: missing evidence stays
   unknown. Fill `observation.json`, including `source: "live"` only for a real
   run, caller approval, client execution, Comate execution evidence, the full
   observation window and contract reference. Do not put secrets or full local
   logs in these files. Preserve raw records locally under the operator's policy.
7. Only once a real candidate control and its contract are identified, repeat
   `stage`/`observe` for `candidate`, then `control-after`. Each uses a fresh canary
   in the same workspace. The helper requires a settled snapshot before the next
   stage and refuses to overwrite observations. If no control is documented,
   stop after collecting the baseline; leave the candidate unrun.
8. Generate a report and review it using the evidence rules below:

   ```sh
   node packages/comate/boundary-check.mjs report CASE
   ```

   The report preserves operator assertions separately from observations; it
   never upgrades them into a verified execution/prevention verdict. Label
   candidates extracted from TOOL structures still need the source schema checked.
   Empty labels, unfamiliar kinds, parse errors or a missing terminal require
   manual inspection of the local sanitized capture. A task terminal alone does
   not prove a complete execution-log window. The helper compares declared model
   and versions; the operator must also compare actual request/settings evidence.

To investigate read-only behavior, an **explicitly approved** optional `prepare
write` case asks only to copy the nonsensitive canary to a new named file in the
same workspace. Do not overwrite existing files. Use the same write probe for a
known allowed positive control and the candidate restriction, with another
positive control afterward. Changing to an execution-capable mode for a control
requires local authorization. If the allowed control never executes, the candidate
has not established a restriction. Test readable capability separately with the
read case. No write run was performed against real Comate in this investigation.

The official CLI offers an alternative diagnostic interface, after inspecting
the installed `comatecli run --help`: `run -q <staged prompt> -m <exact model ID>
--mode <documented mode> --cwd <case workspace>`. Its output/captures are CLI
evidence only until service/version and dispatcher equivalence to this adapter
are established. The helper intentionally does not launch it or supply auth.

## Evidence rules

| Classification | Required distinction |
| --- | --- |
| Not run | No live attempt. Self-tests remain synthetic even if every assertion passes. |
| Not triggered | A complete, correlated observation window shows no native invocation. It says nothing about whether a tool would be permitted if requested. |
| Unsupported | The installed version's contract or correlated dispatcher response explicitly rejects the mode/field/tool as unsupported. A model saying it cannot read is insufficient. |
| Blocked before execution | A correlated dispatcher/policy denial establishes rejection before tool start, supported by a complete window, no attributed effect, and executing positive controls. Report the tested tool/path/version scope only. Cancellation or a missing event is insufficient. |
| Executed | A correlated Comate execution/result log establishes execution; for a read, the fresh canary can corroborate it only when absent from initial context/history and client results. A matching file write establishes an effect but requires attribution excluding client/operator writers to call it native Comate execution. |
| Indeterminate | Missing/cut-off logs, uncorrelated events, unknown fields accepted, client/tool attribution ambiguous, controls failing, version/settings mismatch, or incomplete observation window. Preserve these failures. |

A successful bounded experiment is not a universal tools-off guarantee. Read-only
also does not mean no tools or no file access. Any future support claim needs
contract-backed enforcement for the actual HTTP dispatcher, not just a model
following instructions on selected trials.

## Minimal remaining dependency

The coordinator needs an authorized signed-in desktop/service and the local
operator's isolated workspace, or the already-captured **sanitized** native-event
and execution-log excerpts. For each relevant run, supply exact model/version
identities, consistent event IDs/times, names/results/denials, scratch-file hashes
and client approval/execution evidence. For a candidate restriction, additionally
supply the exact service contract/help excerpt and comparable positive controls.
No token, license, authorization header, complete log archive or private project
is needed. Native Windows and Linux desktop acceptance remain unperformed.
