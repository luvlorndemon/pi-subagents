# Native sessions in this fork

For users and maintainers of `luvlorndemon/pi-subagents`. This document describes package entry `src/native.ts`; older persona examples in the preserved upstream documentation refer to `src/index.ts`.

## What the child receives

1. Pi creates an ordinary session and assembles its system prompt. This fork never copies the parent's `ctx.getSystemPrompt()` and never adds a persona or workflow role prefix.
2. The parent's task becomes the child's user message. `inherit_context` explicitly prepends the existing text export of the parent conversation, excluding tool results and images. This is not a full session fork.
3. Native project instructions, settings, skills and extensions still apply. A `SYSTEM.md` or another extension can therefore change the prompt, as in an ordinary Pi session.
4. Model and thinking inherit unless specified. Pi's native settings and loaded extensions determine the child's tools, including pi-purge's configured loadout and deferred/codemode/MCP tools. The parent's temporary active-tool selection is not copied as a child allowlist. This fork adds no tool allowlist, denylist or per-call permission checks; Pi, other extensions and operating-system permissions retain their normal behavior. StructuredOutput and explicitly enabled nested orchestration tools are added for those features.

The runtime/display name `pi` identifies a session. It has no registered persona, role prompt or role default model. Project/user/package agent definitions are ignored and left on disk. Default-agent, fallback-agent, strict-agent-file, package-agent and custom Agent-description settings have no effect. Their menu rows and the persona creation action are hidden.

`name` assigns a task handle. Use `resume` with the returned agent ID for a finished child; use `steer_subagent` with its ID or handle while running. Foreground and background resume both refuse running/queued tasks without changing their status, result or controller. In-memory resume keeps that child's configuration. Reopening an evicted session builds a fresh runtime from the current parent's configuration while preserving saved conversation. Reopening a child owned by a different parent forks its file to avoid interleaved histories.

Worktree cleanup closes the old session's extensions before removing the directory. A clean worktree can be resumed: Pi rebuilds its tools and extensions in the recorded source directory, preserving conversation history, the selected model/thinking level and the child's live pi-purge snapshot. Foreground/background resume and disk reopen use that source directory, including a caller-supplied `cwd`. A worktree with saved changes cannot be resumed directly; the refusal names its preservation branch. Session metadata records the source and completed cleanup state for future reopen. A cancelled reconstruction does not start a model turn; another resume waits until the cancelled run has finished settling.

Project trust stays scoped to the parent's directory. A worktree made from that same directory may inherit its trust (real-path aliases count as the same directory). A different `cwd`, and a worktree made from it, do not inherit that trust; Pi therefore does not start the foreign project's MCP commands automatically. This uses Pi's project-trust mechanism and adds no tool allowlist or per-call gate.

## pi-purge integration

Use the companion modified pi-purge containing `src/subagent-bridge.ts`. An unmodified pi-purge can load normally, but cannot transfer unsaved session settings.

A versioned in-process registry and AsyncLocalStorage transfer configuration data, never a composed prompt. Each spawn copies its immediate parent's current configuration before entering a queue. Later parent changes affect new spawns only. Children have independent configuration, tool loadouts and continuation state. Grandchildren inherit from their immediate parent.

The captured pi-purge extension path is explicitly loaded, including when the parent used `pi -e` temporarily. Pi deduplicates discovery and explicit paths. `isolated: true` opts out of extensions, including pi-purge. Pi's global no-extension switch disables ordinary discovery; captured explicit paths follow Pi's explicit-extension behavior.

For worktrees or `cwd` overrides, profile/rule reads use the parent configuration root; tools and `{{cwd}}` use the actual child directory. Configuration is copied, but profile/rule files retain pi-purge's normal per-turn reads. Explicit child save/edit commands write under the child's cwd; reload reads the configuration root. Transferring settings writes no files.

Completion waits for `session.prompt()` to settle, including pi-purge's native continuation rounds. Cancellation stops the run. This fork does not change pi-purge's refusal detector, continuation limits or manually composed tool-list behavior.

## Orchestration compatibility

| Surface | Native behavior |
|---|---|
| `Agent` | No `subagent_type` in schema; legacy supplied values ignored with a result note. |
| RPC spawn | Omit `type`; legacy values ignored. Existing channels/envelopes preserved. |
| Workflow `agent(prompt, opts)` | `agentType` ignored. Pipeline, gate, schema and resume preserved. Put the output format in the task. |
| Schedules | Stored jobs run native sessions. Snapshot is taken when each execution spawns, not when the schedule is created. |
| Nested delegation | `nativeDelegation` defaults false; depth, concurrency and ownership constraints still apply. |
| Worktree | Clean worktrees resume in their recorded source directory; changed worktrees are refused with the branch named. Cross-project worktrees do not inherit parent project trust. No extra system directive: use relative paths or the actual worktree path in tasks. |

## Testing

```sh
npm ci --ignore-scripts
npm run check
```

Development dependencies pin Pi 1.5.2. Native tests use the real SDK with an offline scripted provider and temporary config/auth paths. They cover prompt assembly, context opt-in, foreground/background, resume, queue snapshots, native tools in nested sessions, delegation depth, RPC, schedules, workflows, concurrent pi-purge continuation and cancellation. Tool regressions exercise writes absent from the parent's active selection, deferred/codemode extension calls, real stdio MCP discovery through tool_search, and preservation of another extension's tool_call hook.

Worktree regressions use real temporary Git repositories and marker MCP servers. They verify same-source versus foreign project trust, clean foreground/background resume, persisted source-directory recovery, retained pi-purge snapshots, changed-worktree refusals, cancellation during reconstruction and duplicate-resume state preservation.

Companion tests use `../pi-purge/src/index.ts` by default; set `PI_PURGE_EXTENSION` to override it. Only companion cases are skipped when that file is absent. Upstream tests exercise the preserved original entry. Windows fixture tests use native paths and async cleanup retries. Live model tests remain opt-in. macOS/Linux have not been verified on a real machine for this fork.

## Updating from upstream

`origin` points to your fork; `upstream` points to `tintinweb/pi-subagents`. Commit your own changes before merging an update. Fetch and inspect the upstream diff, merge the desired revision, resolve conflicts, then run both plugins' checks. Commit and push manually when satisfied.

Most customization lives in `native.ts`, `native-mode.ts`, `native-context.ts`, `native-session.ts` and `native-worktree.ts`, with hooks in the existing registry, manager, runner, UI and workflows. The inactive upstream persona implementation remains for comparison and regression tests. Loading both entries simultaneously is unsupported.

Unrelated UI/orchestration updates should usually merge directly. Changes to Pi session construction, extension lifecycle, prompt assembly, tool boundaries or scheduling may need adaptation. A fork preserves your changes in Git; it cannot guarantee conflict-free future updates. There is no automatic push, release or upstream synchronization.
