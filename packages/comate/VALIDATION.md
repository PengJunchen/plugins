# 0.4.0 images, native continuation and long tasks — 2026-11-02

This section supersedes the 0.3.0 candidate below. Same local branch:
`codex/comate-cloud-local-20261102`, based on `b04626a`. No remote push,
market listing, npm publication or maintainer approval.

## Requested behavior restored

- No total generation timer. Metadata, uploads, response headers, first byte and
  inter-byte silence retain separate deadlines. Continuous activity can run indefinitely;
  client cancellation still aborts the request. Host/client timeouts are independent.
- Inline PNG/JPEG/WebP/GIF in OpenAI data-URL and Anthropic base64 forms, including
  image-only user messages and native tool image results. Upload limit: 5 per request,
  each <=10 MiB decoded. Remote URLs and documents are explicit errors.
- Native cloud conversation/task reuse, incremental user queries and `toolUseResults`.
  Returned client call IDs are correlated with original cloud IDs/names/parameters;
  errors remain errors, image results remain images. Native cloud function events are
  preferred over asking the model to emulate text markers. Existing parser/choice
  validation is still applied to the resulting client calls.
- Per-instance, credential/model/session isolation. Same-session concurrent generation
  returns 409. Missing session IDs, cache loss, branch/tool-catalog changes and missed
  intermediate turns fall back to full transcript replay. Failed/cancelled state is dropped.
  No fallback to Comate's desktop execution service was introduced.

## Verification

**100 package tests passed, 0 failed, 0 skipped**, with explicitly selected cached
production Magpie host `host-a436cfb4eefb.js`, Bun 1.4.4 and Node 26.4.0.
43 cover the cloud transport/host/features; remaining tests cover shared components and
historical local fixtures, not all new cloud behavior. New cases include original-ID native
result correlation, streamed calls, account/model/session isolation, history/tool changes,
cache loss, inline image forms, image-only requests, tool images, no duplicate image upload,
upload failure, cancellation, invalid native results, failure eviction and concurrent calls.
A fake-clock test drives **10 minutes of continuous output** and sees successful completion;
a separate real short-idle fixture verifies a stalled stream fails and releases its session.
This is virtual-time long-task evidence, not a ten-minute live model run.
All 16 repository provider-hook checks and `git diff --check` passed.
npm dry-run includes exactly 9 runtime/docs/license files, excluding tests and historical fixtures.

### Real native cloud continuation through installed Magpie production host

Model: `glm-4.7-fc_0932b6afb498412fb4a02966066ab62c`.
Two consecutive user turns each requested a different fresh random scratch file.
Both initial requests omitted that file's challenge; the actual client executed `read_file`,
returned its result and received a final answer containing the complete challenge.
Both answers used prose/code fences, so **exact-output match was false**; content checks passed.
All four execute POSTs used conversation `21518889`, task `4063854`. Only the first was
`isFirstQuery:true`. The two result-only POSTs had `isUserQuery:false` and native result IDs
`call_0713f30dae2d4092bcb740f9` and `call_8c86d5e0c304448b9a84f244`, both `success:true`.
These observations distinguish native continuation from our former full-history replay.
The test client's auth store/scratch files were isolated and removed afterwards.

### Real images and image-context continuation

A generated 64x64 solid red PNG was sent through the real host, not supplied as text.

| Model | First answer | Second turn without another upload | Cloud task |
| --- | --- | --- | --- |
| Kimi K3.1 Pro `kimi-k3.1-pro_5c3deb5655824ba8a8c75b32a3b1b809` | Red | Red | 4063867 |
| GLM-5v Turbo `glm-5v-turbo_53f84ce17fec43dbbe1f3d9b574f0a85` | **Red** | **Red** | 4063873 |

Each run created one conversation/task, uploaded exactly one PNG, sent one IMAGE context
on the first execute, and used the same task with zero new image contexts on the second.
The question asked for the image's dominant color; it did not name the expected color.
These trials cover PNG with two models, not every accepted media type or model.

Failures retained: the first native trial still requested emulated marker output and GLM
returned malformed marker text rather than a client call. Switching the cloud prompt to
native function calls passed the two-turn test above. An early GLM image trial also requested
an unoffered tool and failed closed. After replacing filename-shaped prompt placeholders
with an attached-image marker, the GLM and Kimi image trials passed; this is an observed
before/after, not proof of every backend cause. Packaging dry-run was run from the package directory.

The latest no-client-tools scratch trial again returned 502 for unoffered read_file,
with zero client executions/desktop requests, no challenge disclosure, unchanged source and no copy.

Installed-source readback remains signed in with 15 models; seven currently advertise image
input from their live `supportImage` fields. Source path remains registered in the user's
existing Magpie. No other agent's model selection was changed.

Real Codex/Claude Code complete gateway acceptance, Windows/Linux native execution and a
maintenance review remain separate pending evidence. Sanitized native/image wire summaries
are retained locally; original licenses, image base64 and scratch contents are omitted.

---

# Cloud revision validation — 2026-11-02

Branch: `codex/comate-cloud-local-20261102`, based on our `85e021a`.
Local development version: `0.3.0`; no npm/GitHub release and no new review approval.
The desktop report below is historical, not the behavior of this revision.

## Scope and design

Only our community-plugin branch changes; no Magpie gateway patch or change to the supplied
`magpie-comate-auth-0.2.13` directory. Runtime `index.mjs` no longer contains the desktop
conversation/cancel/model-list transport. Cloud transport is in `cloud.mjs`; shared protocol
and discovery sources are unchanged. Historical local transport lives in a fixture excluded
from npm. New entry point never imports it.

Each request creates a new cloud conversation/task and replays the complete client transcript.
We deliberately do not adopt 0.2.13's module-wide continuation cache, local fallback,
static model seeds, guessed tool aliases, fabricated bookkeeping success or unknown-tool output.
Cloud function fragments are translated only for declared names and pass through our existing
nonce parser, choice/parallel checks and client-call generation. Tools execute in the client.
Long transcript cost/performance remains unmeasured.

## Current verification

- Node 26.4.0, cached Bun 1.4.4 and explicit unmodified production host
  `~/.cache/magpie/plugin-host/host-a436cfb4eefb.js`.
- Full package suite: **78 pass, 0 fail, 0 skip** with explicit host and Bun.
  New cloud unit/host tests: **21 pass**. Remaining tests include the unchanged shared
  protocol/discovery checks and historical local fixtures; they are not all cloud proofs.
- All **16** repository provider-hook checks passed. `git diff --check` passed.
- npm dry-run: exactly **7** payload files (LICENSE, README.md, index.mjs, cloud.mjs,
  protocol.mjs, discovery.mjs, package.json); no fixture, tests, installers or binaries.
- Real cloud catalog: **15** current-account models; exact live test model
  `glm-4.7-fc_0932b6afb498412fb4a02966066ab62c`.
- Real direct-cloud text request returned `COMATE_CLOUD_OK` with HTTP 200.
- Real installed Magpie production host, isolated auth store: two consecutive user turns,
  each using a different random scratch file. Initial request did not contain its challenge;
  a real client `read_file` call read it, matching call ID returned the contents, and the
  final answer exactly matched each challenge. Temporary files/auth store were removed.
  This was our bounded Node test client through the real Magpie plugin host, **not Codex
  or Claude Code and not a four-protocol gateway acceptance run**.
- No-client-tools scratch trial: cloud returned HTTP 502 for an unoffered tool;
  0 client executions, 0 desktop network requests, no challenge in reply, source unchanged,
  destination absent. Three cloud POSTs. This proves that trial's local execution boundary;
  it does not prove all backend tools disabled for every model or endpoint.
- Installed the source path into the user's existing Magpie and completed desktop-account
  login. Independent CLI readback: installed=true, signedIn=true, models=15.

Failed attempts retained: first host test used plain JSON where the host protocol expects
base64 and failed before generation; corrected the test client. Two subsequent first-turn
trials performed the client tool successfully but added prose/code fences around the complete
challenge, failing the exact-output assertion. The final two-turn run matched both challenges
exactly. No model/provider fallback was used. One accidental root-level Node test discovery
also ran unrelated Bun suites and failed on `bun:` imports; this is not a valid package gate.
The scoped Node package suite and Bun provider checks above are the applicable checks.

## Review boundary

[PR #77 final review](https://github.com/magpie-community/plugins/pull/77#issuecomment-6166443172)
closed the desktop design because native tools bypassed client permissions. Removing its
execution endpoint addresses that transport path; the current cloud design is a new proposal,
not an approval of the old PR. A fresh Codex/Claude Code gateway run and maintainer review
are still required before claiming community acceptance. Windows/Linux native runs remain
unverified. No market entry has been restored, no package has been published, and no PR changed.

---

# Comate validation

Real captures and sanitized evidence are recorded in [PR #77](https://github.com/magpie-community/plugins/pull/77).
Diagnostic programs, raw client logs and desktop captures stay outside this repository.

## Tested revision and environment

Recorded on 2026-10-13 using `9bca3ae7f5b7d2ef34edb4a6cde3d81efc9ac1b2`
and unmodified upstream Magpie `e2b3eb7406039a6e986a04e152737db4841670b4`
(`-tags nogui`), macOS, Node.js 26.4.0 and Bun 1.4.2.
Runtime source SHA-256 values matched both clients' captured setup records:

| Source | SHA-256 |
| --- | --- |
| `index.mjs` | `d9a584d3c9135d2610aaca480ee3b2122ef7c67bdeebd18ab3c5708a47c1e688` |
| `protocol.mjs` | `e4d80e8b98f7a5b9dadf129c2e51779c959100f1f7d9dfdd8d95cabf28fdc06c` |
| `discovery.mjs` | `5e3542a00755ae3a3457d60a02d857fdb8d4137ec6975824f3fdfc6128d5a04d` |

| Automated check | Result |
| --- | --- |
| Node package suite, explicit upstream production host | 57 passed, 0 failed, 0 skipped |
| Community Bun suite, fresh temporary HOME and explicit upstream host | 1095 passed, 0 failed, 0 skipped across 108 files |
| Provider hook checker | All 16 providers passed |
| npm dry-run payload | LICENSE, README.md, discovery.mjs, index.mjs, package.json, protocol.mjs |

The host integration uses a synthetic loopback service. Real-client and
desktop-tool observations below come from separate live runs.

## Real clients

Both clients selected the live model
`comate/glm-4.7-fc_0932b6afb498412fb4a02966066ab62c` through Magpie.
Each completed a first user turn and a second user turn resumed in the same
client session. Each turn used a distinct independently generated scratch file;
its contents were absent from the initial request for that turn.

| Client / turn | Actual tool call ID | Result and final |
| --- | --- | --- |
| Codex CLI 0.152.0 / first | `call_797d059d36d94a568fa329d6` (`exec_command`) | Local exit 0; matching result POST seq 2; final equals fresh challenge |
| Codex CLI 0.152.0 / resumed | `call_084ae40400aa479f9678e42a` (`exec_command`) | Local exit 0; matching result POST seq 4; final equals new challenge |
| Claude Code 2.1.205 / first | `call_af2ff85e6f3642c5a7587381` (`Read`) | Non-error result POST seq 3; successful final contains fresh challenge |
| Claude Code 2.1.205 / resumed | `call_87d59e57f5834a57a0b39707` (`Read`) | Non-error result POST seq 3 in the resumed recorder; successful final contains new challenge |

All four CLI processes exited 0. Codex used the same thread in both turns;
Claude used the same session in both turns. Gateway and desktop recorders
forwarded original request bodies and response bytes unchanged. The gateway's
only provider was Comate, with independent client/gateway configuration.
No fixture or replay supplied a tool result. Detailed historical attempts
and their observed failures are retained in the PR record.

## Native desktop tools

The retained historical provider SSE contains native `read_file` events
(12 `executed`, one `failed`) and five `run_command` events with state
`executing`. These names come from exact `TOOL` elements, including captured
`response-error` bodies, rather than client declarations or marker text.

Direct requests to `/api/v1/conversations/init` used `mode: "Ask"` and
`enableCodebaseSearch: false`, without client function tools or client results.
GLM-4.7 and Kimi K3 each emitted a native `read_file` element with
`state: "executed"`, `toolState: "executed"`, `detail.kind: "read"`, followed
by `task_done`. Each returned the full fresh challenge absent from its query;
the source file stayed unchanged. These were Comate reads independent of
Codex and Claude tool approval.

A separate GLM-4.7 Ask request read another fresh scratch file and asked to
copy it to a new scratch filename. It emitted `read_file` as executed,
returned the challenge, answered that it could not create the destination
in Ask mode, and finished with `task_done`. The source hash stayed unchanged
and the destination did not appear. This records that trial's behavior.

## Reproduction

1. Use a signed-in Comate desktop and unmodified upstream Magpie. Install
   this source package with `magpie plugin add /absolute/path/to/packages/comate`
   and sign in with `magpie plugin login comate`. Select an exact ID from the
   live `comate/` catalog.
2. Point independent Codex Responses and Claude Messages configurations at
   that isolated gateway, using only the Comate provider and a scratch folder.
3. Generate a random file without putting its contents into the prompt. Ask
   the client to read it, return the tool result, and answer with its contents.
   Check the actual call, execution, matching result ID and full final content.
4. Generate a different file and resume the same client session. Repeat the
   call/result/final checks against the new contents.

Published excerpts omit account names, licenses, headers, private paths and
challenge values. Copied credentials and test processes were cleaned up.
