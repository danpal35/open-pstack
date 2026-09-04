# Grok and Terra role-swap verification

Candidate: open-pstack `1.2.1-grok.1`. Tested on macOS with T3 Code `0.0.38`, Grok CLI `1.0.13`, and Bun `1.3.10` on 2026-09-04.

Create an isolated Git project with two directories, `grok-writer` and `terra-writer`. Each starts with a `calc.py` containing only a `sum_positive(values)` stub raising `NotImplementedError`. Each `check.py` must verify empty input, all nonpositive input, mixed integers, and mixed floats, then print `PASS`. Install the candidate plugin for the test project.

From a real T3 Grok main conversation:

1. Assign Grok `grok:grok-4.6@high` to the first directory and Terra `codex:gpt-5.6-terra@medium` to the second. Use the runner with `--parent grok`, `isolated-write`, and separate prompts, outputs, receipts, and background task handles.
2. Ask each worker to implement the sum of strictly positive values and run its tests. The parent must not implement the function.
3. Drain both writers, then swap the models for independent `read-only` reviews. Require each reviewer to inspect the implementation, run `check.py`, and give a PASS/FAIL verdict. No defects found is a valid result.
4. Drain both reviewers and run the artifact verifier, pointing it at only this attempt's evidence directory:

```sh
python3 tests/grok-role-swap.py /path/to/verification-project /path/to/verification-project/evidence/release
```

The verifier checks four distinct routes, exact models and requested efforts, actual parent, complete receipts, provider model evidence, sandbox and approval flags, review verdicts, and both implementations' tests. It rejects duplicate routes so stale successes cannot substitute for the selected attempt.

Additional observed checks:

- A Codex parent ran a Grok read-only sandbox probe. The worker attempted a project-file write, caught `PermissionError`, and reported `READ_ONLY_BLOCKED`; the target file was absent.
- A real T3 Claude main conversation ran a Grok read-only worker that shelled out to read a marker. Its receipt recorded `parent=claude`, `grok-4.6@high`, `complete`, and provider-reported model verification. No Anthropic worker was spawned.
- A native Terra forward review exercised a feature-only assignment change. It preserved the refactoring assignment, other panel lanes, efforts, and the operator's excluded providers.
- Automated validation: 170 Bun tests pass, strict TypeScript checks pass, static plugin invariants pass, and Claude plugin manifest validation passes.

Local live evidence is retained in the sibling `pstack-grok-verification` project: `evidence/release`, `codex-parent-probe/sandbox-final-receipt.json`, and `claude-parent-probe/receipt-c2g-20260904-1.json`. T3 Grok thread: `07e99003-45b2-4228-95ee-eac410cb86ca`. T3 Claude thread: `d9f421a7-b41e-4947-bd4e-8db0a505b439`.

The original live test caught Grok returning exit zero after a permission cancellation. Regression tests now reject cancelled, truncated, and missing terminal reasons, and verify that a cancelled worker does not publish an output artifact. Read-only Grok explicitly uses auto approval mode while retaining its read-only OS sandbox. Both HOME and GROK_HOME remain isolated; inheriting the real home can hide permission failures by importing ambient Claude settings.

These small tasks verify dispatch, editing, review, and isolation behavior. They do not compare the models' quality on larger engineering tasks. A future Grok CLI or pstack update should rerun the live checks, especially the sandbox probe.
