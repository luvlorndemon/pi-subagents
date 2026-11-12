import { resolve } from "node:path";
import {
  createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension,
  DefaultResourceLoader, type ExtensionContext, getAgentDir,
  type ModelRuntime, SessionManager, SettingsManager, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { RunOptions } from "./agent-runner.js";
import { runInChildSessionContext } from "./child-context.js";
import { captureNativeContext, withNativeContext } from "./native-context.js";
import { nativeDelegationEnabled } from "./native-mode.js";
import { createNestedSubagentTools, getMaxSubagentDepth } from "./nested-tools.js";
import { createStructuredCapture, createStructuredOutputTool } from "./structured-output.js";

/** Session construction only. Pi owns all system-prompt generation here. */
export async function createNativeSession(ctx: ExtensionContext, options: RunOptions, persist: boolean) {
  const snapshot = options.nativeContext ?? captureNativeContext(ctx);
  const cwd = options.cwd ?? ctx.cwd;
  const configRoot = options.configCwd ?? ctx.cwd;
  const agentDir = getAgentDir();
  const modelRuntime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
  if (!modelRuntime) throw new Error("Native subagents require pi 1.5.2's parent model runtime.");
  const settings = SettingsManager.create(configRoot, agentDir, { projectTrusted: ctx.isProjectTrusted() });
  const sessionSettings = resolve(cwd) === resolve(configRoot) || options.worktreeBase
    ? settings
    : Object.assign(SettingsManager.create(configRoot, agentDir, { projectTrusted: ctx.isProjectTrusted() }), { isProjectTrusted: () => false });
  const capture = options.structuredOutput ? createStructuredCapture() : undefined;
  const customTools: ToolDefinition[] = options.structuredOutput && capture
    ? [createStructuredOutputTool(options.structuredOutput, capture)] : [];
  const maxDepth = options.nestedRuntime?.maxSubagentDepth ?? getMaxSubagentDepth();
  if (nativeDelegationEnabled() && !options.isolated && options.nestedRuntime && options.nestedRuntime.depth < maxDepth) {
    customTools.push(...createNestedSubagentTools({
      ...options.nestedRuntime, pi: options.pi, maxSubagentDepth: maxDepth,
      allowedSubagents: "all", configCwd: configRoot,
    }));
  }
  const noExtensions = options.isolated === true || process.argv.some(arg => arg === "--no-extensions" || arg === "-ne");
  const purgePath = !options.isolated ? snapshot.purge?.extensionPath : undefined;
  return withNativeContext(snapshot, () => runInChildSessionContext(async () => {
    const loader = new DefaultResourceLoader({
      cwd: configRoot, agentDir, settingsManager: settings, noExtensions,
      noSkills: options.isolated === true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: purgePath ? [purgePath] : undefined,
      extensionFactories: [
        { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
        { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
        { name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
      ],
      disabledBuiltinExtensions: noExtensions ? ["codemode", "tool-search", "mcp"] : process.argv.includes("--no-mcp") ? ["mcp"] : undefined,
    });
    await loader.reload();
    if (purgePath && !loader.getExtensions().extensions.some(extension => resolve(extension.resolvedPath) === resolve(purgePath))) {
      const error = loader.getExtensions().errors.find(entry => resolve(entry.path) === resolve(purgePath));
      throw new Error(`Could not load inherited pi-purge extension: ${error?.error ?? purgePath}`);
    }
    const parentSession = ctx.sessionManager.getSessionFile();
    const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR ?? settings.getSessionDir();
    let sessionManager: SessionManager;
    if (options.resumeSessionFile) {
      sessionManager = SessionManager.open(options.resumeSessionFile, sessionDir);
      // Pi's forkFrom header records the source child, not our owning parent.
      // Keep ownership in a non-message entry so another reopen by the same
      // parent continues this fork rather than creating a fresh fork every time.
      const ownership = sessionManager.getEntries().slice().reverse().find(entry => entry.type === "custom" && entry.customType === "pi-subagents:native-owner");
      const owner = ownership?.type === "custom"
        ? (ownership.data as { parentSession?: string }).parentSession
        : sessionManager.getHeader()?.parentSession;
      if (owner !== undefined && owner !== parentSession) {
        sessionManager = SessionManager.forkFrom(options.resumeSessionFile, sessionManager.getCwd(), sessionDir);
        sessionManager.appendCustomEntry("pi-subagents:native-owner", { parentSession });
      }
    } else {
      sessionManager = persist ? SessionManager.create(cwd, sessionDir, { parentSession }) : SessionManager.inMemory(cwd);
    }
    const { session } = await createAgentSession({
      cwd, agentDir, modelRuntime, model: options.model ?? ctx.model,
      thinkingLevel: options.thinkingLevel ?? ctx.thinkingLevel,
      settingsManager: sessionSettings, sessionManager, resourceLoader: loader,
      customTools,
    });
    session.setSessionName(`pi#${options.agentId?.slice(0, 8) ?? "task"}`);
    await session.bindExtensions({ onError: error => options.onToolActivity?.({ type: "end", toolName: `extension-error:${error.extensionPath}` }) });
    return { session, structuredCapture: capture };
  }));
}
