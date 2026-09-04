# Grok tool mapping for pstack

T3's Grok conversations run the Grok CLI through ACP. They are Grok parents, including when skills were discovered through Claude compatibility. Read [provider-dispatch.md](provider-dispatch.md) and `~/.grok/pstack-models.md` before dispatch. Keep the shared skill's workflow and translate its tool actions here.

| pstack action | Grok action |
| --- | --- |
| Read a file | `read_file` |
| Search files | `grep_search`, `list_dir`, or `run_terminal_cmd` with `rg` |
| Edit files | `search_replace`, `write_file`, or a terminal command |
| Invoke a skill | Read its discovered `SKILL.md` and follow it; a Claude `Skill` tool is not required |
| Track tasks | `todo_write` |
| Ask the user | Ask in plain text, or use a question tool if the session exposes one |
| Launch a configured worker | Run `pstack-runner --parent grok` through `run_terminal_cmd` with `is_background: true` |
| Wait for that worker | `get_task_output` using the returned task handle |
| Cancel that worker | `kill_task` using the retained handle; inspect the cancelled receipt |
| Drive the app | Run the CLI, or use the available T3 preview tools for a UI |

Grok may label its terminal tool `bash` in help or transcripts. Use the name exposed by the current session. If background execution or task supervision is unavailable, report that limitation before dispatching a long-running lane. Do not launch an untracked shell process with `&`.

Every explicit provider/model/effort descriptor uses the external runner, including Grok workers. For example, the same feature role can run as `codex:gpt-5.6-terra@medium` or `grok:grok-4.6@high`. Preserve the role's access mode, prompt, and dedicated worktree when swapping models. Give each attempt unique output and receipt paths and verify both before accepting the result.

Claude agent definitions such as `poteto-agent` and `pstack-fable-max` do not establish a native Claude lane in Grok. Never dispatch them just because compatibility discovery makes them visible. Honor the user's provider exclusions. `orchestrator-inline` means no spawn; `inherit-parent` and `auto` only use Grok's native `task` tool when available.

Configured external workers do not receive the parent's MCP connections. Keep MCP-dependent work in the parent when its role is inline. Do not claim that a worker can use a connection based on the parent's tool list.

## Instructions and role changes

Grok reads global instructions from `~/.grok/AGENTS.md`. Its role sheet is `~/.grok/pstack-models.md`. Setup can mirror the sheet between `<!-- pstack:models:begin -->` and `<!-- pstack:models:end -->` in the instructions file, preserving all other text. The sheet remains the editable source; re-read it before dispatch even when the session began with an older mirror.

Use setup-pstack's **Change named roles** path for a persistent swap. An explicit request to change a role authorizes that edit after the selected route passes its probe. Leave unrelated roles, provider exclusions, and other parents' sheets alone unless the user requests a shared configuration.
