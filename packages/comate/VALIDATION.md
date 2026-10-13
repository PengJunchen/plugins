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
completed a real client-tool/result/assistant-continuation cycle limited to
each client's first user turn using
`comate/glm-4.7-fc_0932b6afb498412fb4a02966066ab62c`; same-session follow-up
prompts have not passed in the recorded attempts.
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

## Native boundary status (2026-10-13)

The official IDE description supports an intended read-only Ask mode with search
tools enabled; enforcement for this local HTTP service remains unverified.
Only `read_file` is explicitly named as native in the public historical record.
Correlated Comate execution logs and file observations for those attempts are
still unavailable here. No new live Comate/client boundary test was run in the
cloud, which has no signed-in Comate service or authorized desktop access.

The investigation notes, offline helper and six synthetic self-tests were removed
from the current tree at the [reviewer's scope request](https://github.com/magpie-community/plugins/pull/77#issuecomment-6138738756).
They remain available in immutable [commit 25f68ae](https://github.com/PengJunchen/plugins/tree/25f68ae085b2a2fb9df17deee154684cc64825a4/packages/comate)
for later authorized local investigation. That commit's 62-pass/1-skip Node and
1101-pass Bun results included those six self-tests; they are historical synthetic
results, not evidence of real Comate execution or prevention and not current test
totals.

## Checks after scope cleanup (2026-10-13)

Cloud checks used Node.js 24.19.0, Bun 1.4.3 and an
unmodified upstream host checkout at
`61c40b80bb17f8a451a25037b8561760715fb13d`. These checks use synthetic services;
they do not run a real Comate desktop or establish a native-tool boundary.

| Check | Result |
| --- | --- |
| `node --test` in `packages/comate`, host variables unset | 56 passed, 0 failed, 1 expected integration skip |
| Full repository `bun test`, temporary home, explicit `MAGPIE_CHECKOUT` and `MAGPIE_BUN` | 1095 passed, 0 failed across 108 files, including the synthetic production-host integration |
| `bun scripts/check.mjs` | All 16 providers passed |
| npm pack dry run with a writable temporary cache | Six files: LICENSE, README.md, discovery.mjs, index.mjs, package.json, protocol.mjs |
| `scripts/new-to-npm.sh` | Failed only for the unpublished Comate package; a separate npm registry query returned E404. This existing first-publication prerequisite remains unresolved; no publication was performed. |
| Real Comate native-tool execution/denial, Codex/Claude boundary tests, native Windows/Linux desktop | Not run; missing authorized signed-in desktop/service and correlated execution evidence |
