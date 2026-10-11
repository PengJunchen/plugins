# Comate validation

Current acceptance is recorded in [PR #77](https://github.com/magpie-community/plugins/pull/77).
The candidate remains a draft, is not listed in the market, and is unpublished
on npm. First publication requires a community npm owner.

## Tested revision and environment

Recorded on 2026-10-11: runtime `63540ef594ab1fbbc4cefb034587bf867a6d60d0`,
unmodified upstream Magpie `e2b3eb7406039a6e986a04e152737db4841670b4`
(built with `-tags nogui`, version `dev`), macOS 26.6.2, Node.js 26.4.0,
Bun 1.4.2, Comate app 1.108.2, extension 4.13.4 and local service 1.8.1.
No forked gateway patch is used.

| Automated check | Result |
| --- | --- |
| Comate Node suite, explicit upstream production host | 57 passed, 0 failed, 0 skipped |
| Community Bun suite, temporary HOME and explicit upstream host | 1095 passed, 0 failed across 108 files |
| Provider hook checker | All 16 providers passed |
| npm dry-run payload | Six files; no host helper, tests, binaries or installers |

The host integration uses a synthetic loopback service and checks initial
function-call output; it does not execute a real client tool or establish
continuation. Real-client evidence is recorded separately below.

## Live account metadata

The signed-in local service returned 15 model IDs. The inspected records had
`modelId`, `displayName`, `modelType`, `thinking` and `supportImage` fields,
with optional thinking/effort metadata, but no context, token-window or output
limit fields. Context/input/output limits remain unknown (`0`); client
fallback metadata is not an authoritative Comate limit.

## Real clients

On the recorded runtime, both Codex CLI 0.152.0 and Claude Code 2.1.205
completed a real client-tool/result/assistant-continuation cycle using
`comate/glm-4.7-fc_0932b6afb498412fb4a02966066ab62c`.
Codex executed `exec_command`; Claude executed `Read`. Each tool result
contained the complete independently generated challenge, used the same
call ID in the next request, and was followed by a final answer containing
that challenge. The initial prompts did not include challenge contents.
Runtime source hashes matched the checkout; later commits change only tests
and documentation.

Claude also requested a duplicate same-file Read; the client returned its
"Wasted call" notice and the model used the first result to finish. Additional
same-session CLI resume checks with new files remain unreliable: observed
failures include old-result reuse and native Comate TOOL events after a real
client result. These are separate from the completed fresh-turn cycles.
Every attempt, retry, model ID and redacted wire excerpt is retained in the PR;
HTTP 200 or a text answer alone does not pass.

Independent client and gateway homes keep live user configuration unchanged.
A transparent loopback recorder forwards request bodies and response bytes
unchanged. The only provider in each gateway is Comate. Challenge contents
are generated independently and excluded from the initial user prompt;
subsequent requests carry them in returned tool results and conversation history.
Shared evidence contains no account names, licenses, authorization headers
or private paths. Raw client logs stay local.

## Repeat a real-client check

1. Run signed-in Comate and an unmodified upstream Magpie with this checkout
   installed using `magpie plugin add /absolute/path/to/packages/comate` and
   `magpie plugin login comate`. Wait for the live model catalog to load;
   Magpie refreshes it asynchronously. Select `comate/<exact live model ID>`.
2. Point each client's Responses or Anthropic endpoint at this isolated
   Magpie instance. Record client versions and ensure there is no provider
   fallback. Use independent client settings and a disposable scratch folder.
3. Generate a fresh random challenge file without placing its contents in
   the prompt. Ask Codex to read it with `exec_command`, and Claude Code with
   `Read`, then return the contents after the tool result arrives. Check full
   challenge containment; Read can include line numbers and finals can include prose.
4. Verify the client event and call ID, local execution, matching result in
   the next gateway request and final answer. Resume the same client session,
   generate a new file and repeat. Preserve failures as well as successful runs.

Native Windows and Linux desktop acceptance have not been performed.
Cross-platform discovery fixtures do not establish native desktop support.
The adapter uses prompt-emulated function calls, so model compliance remains
variable even when an individual client run passes.
