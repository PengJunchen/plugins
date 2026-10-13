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
