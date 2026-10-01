---
name: setup-pstack
description: Configure pstack's provider-qualified models, per-family requested effort, and parent-owned routes per role in Claude Code, Codex, or Grok. Verifies the assigned native and external lanes before writing the override sheet. Use for /setup-pstack, "configure pstack models", or swapping models such as Terra and Grok in named roles.
---

# Setup pstack

Configure one portable model sheet for the current parent harness. Read [`provider-dispatch.md`](../poteto-mode/references/provider-dispatch.md) before probing or writing anything. Its model matrix, descriptor grammar, and route table are the contract. Use **Change named roles** for a scoped edit to an existing sheet. The numbered full-setup flow below chooses one requested effort per assigned matrix family. Do not add a second configuration file, a runtime resolver, or a weaker-model fallback.

Claude Code writes `~/.claude/pstack-models.md` and loads it from `~/.claude/CLAUDE.md` with:

```text
@~/.claude/pstack-models.md
```

Codex writes `~/.codex/pstack-models.md`. Codex has no `@` include, so mirror the sheet's exact bytes inside one bounded block in `~/.codex/AGENTS.md` and retain the sheet as the editable source of truth:

```text
<!-- pstack:models:begin -->
<exact contents of ~/.codex/pstack-models.md>
<!-- pstack:models:end -->
```

## Steps

## Change named roles

For a request such as "use Grok instead of Terra for features" or "swap Terra and Grok in the reviewer pool", use this path instead of the full matrix setup below. It supports user-selected models beyond the default matrix and does not require probing or enabling unrelated providers.

1. Establish the actual parent: `claude`, `codex`, or `grok`. Read its existing sheet and operator restrictions. Grok uses `~/.grok/pstack-models.md` and [grok-tools.md](../poteto-mode/references/grok-tools.md). If the sheet does not exist, use the full setup flow or an explicitly user-selected existing sheet as the seed; do not silently borrow another parent's configuration.
2. Resolve the named roles and exact replacement descriptors. Preserve every unrelated row, lane order, inline alias, and provider exclusion. For an existing model, keep its configured effort unless the request changes it. If that model occurs at multiple efforts and the role does not disambiguate, ask only for the missing effort. For an unconfigured model, confirm the proposed effort if the user did not specify it. Examples are `codex:gpt-5.6-terra@medium` and `grok:grok-4.6@high`; they are not interchangeable effort labels.
3. Probe each distinct destination model/effort pair for the changed roles, even when it already appears elsewhere in the sheet, through the route used by this parent, with a tiny read-only task and unique output/receipt paths. On Grok, every explicit descriptor uses the external runner with `--parent grok`, including `grok:*`. On Codex, Codex models use native `spawn_agent`. Check provider model availability and the completion evidence required by provider-dispatch. A failed probe writes nothing. Keep work needing the parent's MCPs inline unless the chosen route supports those tools.
4. Render only the requested edits. A row such as `feature, refactoring:` assigns both roles: if only feature changes, split it into `feature:` and `refactoring:` while preserving refactoring's descriptor. Reject duplicate semantic roles before editing. When swapping two configured models, move each model with its effort and preserve all other panel entries. Show the before/after assignments. A clear request to make these changes is authorization to write; ask only if the intended assignments are ambiguous.
5. Snapshot the sheet and parent integration. Claude uses its existing include. Codex and Grok mirror the exact sheet bytes between `<!-- pstack:models:begin -->` and `<!-- pstack:models:end -->` in their global `AGENTS.md`. Preserve all surrounding instructions. If neither marker exists, append one bounded block. If only one marker exists, or markers are duplicated or reversed, stop without writing. Read both files back, and restore both snapshots if either write or comparison fails. If the sheet is a symlink shared with another parent, disclose which parents would change and require a request covering them; do not silently overwrite the shared target.
6. Report the effective assignments, configuration path, and successful probe evidence. Re-read the sheet before the next dispatch so an old session mirror cannot override the edit. Plugin updates must not rewrite user model sheets.

## Full setup

### 1. Establish the parent

Use the harness and tool surface running this skill: Claude Code, Codex, or Grok. A T3 conversation using Grok has parent `grok`; Claude compatibility discovery does not change it. Environment markers may corroborate that top-level answer, but do not launch a child and ask it to detect where it came from. Record the parent because the same descriptor takes a different route in each harness. Grok writes `~/.grok/pstack-models.md` and mirrors it in `~/.grok/AGENTS.md` using the same bounded block as Codex.

### 2. Load current state

Read the current parent-specific sheet when it exists. Before matrix validation, normalize only the rolling-alias predecessors that earlier pstack releases generated. A provider-qualified Claude model is migratable when its model component starts with `claude-fable-` or `claude-opus-` and the remaining revision contains only digits and hyphens. Replace that component in memory with `fable` or `opus`, preserving the provider, effort, role, and lane order. Record each original and normalized descriptor for the confirmation in step 7. This migration is valid loaded state and does not require a separate operator choice.

Treat the normalized values as current role-to-family assignments. Overlay those rows on the complete first-run role map in step 7. Materialize any missing documented role row from that map on the next successful write. A duplicate role row is inconsistent state; report it and resolve it before probing. A row whose role is not in the step 7 role map, such as `how critics`, is from a retired role. Drop it and list it at confirmation. A bare host-native slug from an older sheet is also invalid because it does not say which provider owns it. A versioned Claude model outside the two migration families remains inconsistent state. If the sheet is missing, use the complete first-run role map and the model matrix's Default effort cells.

Then ask whether to keep these role-to-family assignments or change named roles. Keeping them is the default. Apply only role changes the operator names; never offer a reset of a customized sheet to the first-run assignments. A changed role may use any model-matrix family, `inherit-parent`, or `auto`.

### 3. Parse per-family efforts

Read the model matrix. Every non-alias value must match `<provider>:<model>@<effort>`. Map it to exactly one matrix family by `(provider, model)`, require its effort to appear in that row's Selectable efforts cell, and collect the effort. `inherit-parent` and `auto` rows carry no family effort.

An unmatched provider/model, out-of-domain effort, or duplicate role is inconsistent state. Stop, show the conflicting rows verbatim, and ask for an explicit matrix family or alias replacement. If one or more families have mixed efforts, show every conflicting family and role row, then ask for one normalized effort per family from its Selectable efforts cell. Do not invent a precedence rule. Do not probe or write while any inconsistency is unresolved.

One distinct effort per family is the current value. A family with no non-alias occurrence is unassigned: do not ask for its effort, check its CLI, or probe it. A family that a step 2 role change newly assigns takes its matrix Default effort as the proposed value.

### 4. Collect one requested effort per family

Ask one effort question for each assigned family. Name each model, its current or proposed value, and the Selectable efforts from its matrix row. Empty input keeps that value. On a first run, state the assigned families' matrix defaults before asking. On a rerun, state the parsed values without offering to reset customized role lanes.

### 5. Probe the requested pairs

Probe only the selected `provider:model@effort` pair of each assigned family. Run one probe per family in the role map, even when two families share a provider. Do not enumerate or offer older models as substitutes. A failed probe writes nothing: report the failing pair and provider, stop, and keep the active sheet plus parent integration bytes unchanged. A failed first run creates neither artifact.

| Family | Pair source | Claude parent route | Codex parent route | Grok parent route | Availability proof |
|---|---|---|---|---|---|
| Fable | Fable matrix row + selected effort | native Agent `pstack-fable-<effort>` | Claude CLI | Claude CLI | native one-turn probe or `claude auth status --json` plus one-turn probe |
| Sol | Sol matrix row + selected effort | `codex exec` | native `spawn_agent` | Codex CLI | `codex login status` plus one-turn probe or native one-turn probe |
| Grok | Grok matrix row + selected effort | Grok CLI | Grok CLI | Grok CLI | `grok models` must list the requested model; one-turn probe |
| Opus | Opus matrix row + selected effort | native Agent `pstack-opus-<effort>` | Claude CLI | Claude CLI | native one-turn probe or `claude auth status --json` plus one-turn probe |

Use a tiny read-only probe that returns a unique marker. A login-status command alone proves credentials, not that the requested model and effort flags run. Record native and external results separately. Claude and Codex never call the external launcher for their own provider. On a Claude parent, the Fable and Opus probes are one-turn runs of the mapped `pstack-<stem>-<effort>` agent. On a Codex parent, the Sol probe is native `spawn_agent` with the selected `reasoning_effort`. Every other pair uses the external runner with the selected effort flag. On Grok, every pair uses the runner with `--parent grok`.

Receipts and native transcripts prove the requested effort and the route. They do not prove a provider's hidden applied reasoning depth. There is no implicit timeout, weaker-model fallback, same-provider external fallback, or second mutable configuration source.

### 6. Render, preserving role families

Build the new sheet in memory. Do not write it yet.

- First run: start from the complete role assignments in step 7, with the step 2 role changes applied.
- Rerun: start from the normalized complete role map from step 2, with the step 2 role changes applied, preserving each loaded row's lane order and family (or alias) per lane.

Rewrite every matrix-family descriptor to `provider:model@<requested effort for that family>`. Leave `inherit-parent` and `auto` unchanged. An effort-only rerun cannot change a role's family. Changing Grok's effort updates every Grok occurrence and does not move a Sol role onto Grok. Refuse an unqualified slug, an unavailable route, a model outside the model matrix, or a provider/model mismatch.

### 7. Confirm and commit

Show any rolling-alias migrations as original and normalized descriptors and any retired-role rows dropped in step 2. Then show the route table for this parent and every rendered role and descriptor. Ask for confirmation before writing.

Why and Reflect require the parent's live MCP surface. Keep their investigator, reviewer, and synthesizer roles on `inherit-parent` or `auto`; the bounded external runner deliberately omits ambient MCPs. `inherit-parent` and `auto` always validate, but say when they reduce a panel's provider diversity. For panel roles, one lane runs per entry. The list length is the fan-out count. `arena cross-judge pool` is a list from which Arena chooses a provider different from the parent and base candidate when possible. `swarm workers` is the default for every worker unless a race explicitly assigns another descriptor.

Every non-alias value must match `<provider>:<model>@<effort>` and must have passed step 5.

After the operator confirms, write the in-memory render from step 6. Never paste the example below as the result. It is only the complete first-run role map used to seed step 2; selected efforts and explicit role changes always replace its example values before writing.

```markdown
# pstack model configuration

Provider-qualified per-role choices. Read the installed pstack provider-dispatch reference before dispatching a configured role. Every documented role remains present. `inherit-parent` and `auto` use the parent model natively and still count as one panel lane.

feature, refactoring: grok:grok-4.7@xhigh
bug-fix: codex:gpt-5.6-sol@max
perf-issue: codex:gpt-5.6-sol@max
hillclimb: codex:gpt-5.6-sol@max
judgment and prose: claude:opus@max
hardest tasks: claude:opus@max
how explorer: grok:grok-4.7@xhigh
how explainer: claude:opus@max
why investigators, synthesizer: inherit-parent
reflect tooling, judgment, divergent, synthesizer: inherit-parent
arena runners: claude:opus@max, codex:gpt-5.6-sol@max, grok:grok-4.7@xhigh
arena cross-judge pool: claude:opus@max, codex:gpt-5.6-sol@max, grok:grok-4.7@xhigh
swarm workers: grok:grok-4.7@xhigh
architect runners: claude:opus@max, codex:gpt-5.6-sol@max, grok:grok-4.7@xhigh
interrogate reviewers: claude:opus@max, codex:gpt-5.6-sol@max, grok:grok-4.7@xhigh
```

### 8. Wire it in

Render the parent integration in memory before either write. On Claude, the integration is the single `@~/.claude/pstack-models.md` include in `~/.claude/CLAUDE.md`. On Codex or Grok, it is the exact sheet bytes between one `<!-- pstack:models:begin -->` and `<!-- pstack:models:end -->` pair in `~/.codex/AGENTS.md` or `~/.grok/AGENTS.md`, respectively. Replace that whole bounded block on a rerun. Insert one block at the end on first run. If either marker is missing, duplicated, or reversed, stop and report inconsistent state instead of guessing a boundary.

Snapshot every target's current bytes. Write the sheet and parent integration only after every requested pair passes and the operator confirms. Read both targets back and compare them with the in-memory render. If either write or readback fails, restore every snapshot and report the failure. An unchanged rerun must produce byte-identical sheet and integration content after normalization.

Do not copy the model sheet between harnesses without rerunning the parent-specific probes; route availability can differ even on the same host.

### 9. Behavioral smoke

Before declaring setup complete, run one small read-only mixed panel from this parent: every distinct chosen descriptor, distinct output/receipt paths, and an independent cross-judge. Launch Claude-native agents and every external process in the background with retained handles, then drain them. Verify the native transcript entries and every external receipt. A structural config check or unit test is not a substitute.

Report the sheet path, parent route table, requested-effort probe results, smoke results, and external elapsed/token/cost receipts. Re-running this skill re-probes and updates the same sheet. Do not claim the provider exposed hidden applied-effort observability.
