import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type AssistantMessage, createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { type RunOptions, runAgent, setRememberAgents } from "../src/agent-runner.js";
import { getAgentConfig, getAvailableTypes } from "../src/agent-types.js";
import { runInChildSessionContext } from "../src/child-context.js";
import nativeSubagents from "../src/native.js";
import { captureNativeContext } from "../src/native-context.js";
import { nativeDelegationEnabled, setNativeDelegation, setNativeSessionMode } from "../src/native-mode.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { runWorkflow } from "../src/workflow/runtime.js";

vi.setConfig({ testTimeout: 30_000 });
const purgePath = process.env.PI_PURGE_EXTENSION ?? fileURLToPath(new URL("../../pi-purge/src/index.ts", import.meta.url));
const sessions: AgentSession[] = [];
const managers: AgentManager[] = [];
const initialCwd = process.cwd();
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "native-subagents-"));
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent-home"));
  mkdirSync(join(root, ".pi", "agents"), { recursive: true });
  writeFileSync(join(root, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, workflowsEnabled: false, rememberAgents: false }));
  writeFileSync(join(root, ".pi", "agents", "Explore.md"), "---\nmodel: broken/model\ninherit_context: true\n---\nPERSONA_SENTINEL");
  writeFileSync(join(root, "AGENTS.md"), "NATIVE_PROJECT_RULE");
  mkdirSync(join(root, ".pi", "pi-purge"), { recursive: true });
  writeFileSync(join(root, ".pi", "pi-purge", "config.json"), JSON.stringify({ version: 1, enabled: false }));
  setNativeSessionMode(true);
  setNativeDelegation(false);
  setRememberAgents(false);
});

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const session of sessions.splice(0).reverse()) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  setNativeSessionMode(false);
  setNativeDelegation(false);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  process.chdir(initialCwd);
  if (!resolve(root).startsWith(resolve(tmpdir()) + "/") && !resolve(root).startsWith(resolve(tmpdir()) + "\\")) throw new Error("Unsafe fixture cleanup");
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function parent(withPurge = false, respond: (context: TranscriptContext) => string | Promise<string> = () => "finished") {
  const requests: TranscriptContext[] = [];
  const agentDir = join(root, "agent-home");
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("native-fixture", {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "offline",
    models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      requests.push(structuredClone(context));
      const stream = createAssistantMessageEventStream();
      let ended = false;
      const finish = (text: string, aborted = false) => {
        if (ended) return; ended = true;
        const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: "text", text }], stopReason: aborted ? "aborted" : "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: message });
        if (aborted) stream.push({ type: "error", reason: "aborted", error: message });
        else stream.push({ type: "done", reason: "stop", message });
      };
      options?.signal?.addEventListener("abort", () => finish("", true), { once: true });
      Promise.resolve(respond(context)).then(text => finish(text));
      return stream;
    },
  });
  let api: ExtensionAPI | undefined;
  const settings = SettingsManager.inMemory({ defaultTools: ["read"], compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, systemPromptOverride: () => "PARENT_PERSONA_SENTINEL", additionalExtensionPaths: [fileURLToPath(new URL("../src/native.ts", import.meta.url)), ...(withPurge ? [purgePath] : [])], extensionFactories: [{ name: "capture-fixture-api", factory: pi => { api = pi; } }] });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: runtime.getModel("native-fixture", "test"), settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(root), tools: ["read", "Agent", "get_subagent_result", "steer_subagent", "SubagentWorkflow"] });
  sessions.push(session);
  await session.bindExtensions({});
  if (!api) throw new Error("Native extension did not load");
  const ctx = session.extensionRunner.createToolContext("native-fixture", undefined);
  const run = async (prompt: string, opts: Omit<RunOptions, "pi"> = {}) => {
    const result = await runAgent(ctx, "Explore", prompt, { ...opts, pi: api!, onSessionCreated: child => { sessions.push(child); opts.onSessionCreated?.(child); } });
    return result;
  };
  return { api, ctx, session, requests, run, runtime };
}

describe("native pi sessions", () => {
  it("does not reset delegation when the extension is discovered by a child", async () => {
    const p = await parent();
    setNativeDelegation(true);
    await runInChildSessionContext(async () => nativeSubagents(p.api));
    expect(nativeDelegationEnabled()).toBe(true);
  });

  it("executes the registered Agent tool without a persona, collects background work and resumes it", async () => {
    const p = await parent();
    const agent = p.session.getToolDefinition("Agent")!;
    const call = (params: Record<string, unknown>) => agent.execute("native-call", params, undefined, undefined, p.ctx);
    const foreground = await call({ prompt: "foreground task", description: "foreground", run_in_background: false });
    expect(JSON.stringify(foreground)).toContain("finished");
    const background = await call({ prompt: "background task", description: "background", name: "native-background", subagent_type: "ignored-role" });
    expect(background.details).toMatchObject({ subagentType: "pi", status: "background" });
    const resultTool = p.session.getToolDefinition("get_subagent_result")!;
    const collected = await resultTool.execute("collect", { agent_id: "native-background", wait: true }, undefined, undefined, p.ctx);
    expect(JSON.stringify(collected)).toContain("finished");
    const resumed = await call({ prompt: "resume task", description: "resume", resume: (background.details as { agentId: string }).agentId, run_in_background: false });
    expect(JSON.stringify(resumed)).toContain("finished");
    expect(p.requests).toHaveLength(3);
    expect(JSON.stringify(p.requests[2])).toContain("background task");
    expect(p.requests.every(request => !getCurrentSystemPrompt(request.messages).includes("PERSONA_SENTINEL"))).toBe(true);
  });

  it("has no persona registry and uses native project rules with task-only context by default", async () => {
    const p = await parent();
    expect(getAvailableTypes()).toEqual([]);
    expect(getAgentConfig("Explore")).toBeUndefined();
    const tool = p.session.getToolDefinition("Agent")!;
    expect(tool.parameters).toHaveProperty("properties");
    expect(tool.parameters).not.toHaveProperty("properties.subagent_type");
    expect(tool.parameters).toHaveProperty("required", ["prompt", "description"]);
    p.session.sessionManager.appendMessage({ role: "user", content: "PARENT_CHAT_SENTINEL", timestamp: Date.now() });
    const result = await p.run("child task");
    expect(result.responseText).toBe("finished");
    const prompt = getCurrentSystemPrompt(p.requests[0].messages);
    expect(prompt).toContain("NATIVE_PROJECT_RULE");
    expect(prompt).not.toContain("PERSONA_SENTINEL");
    expect(JSON.stringify(p.requests[0])).not.toContain("PARENT_CHAT_SENTINEL");
    expect(result.session.getActiveToolNames()).toEqual(["read"]);
    await p.run("context task", { inheritContext: true });
    expect(JSON.stringify(p.requests[1])).toContain("PARENT_CHAT_SENTINEL");
  });

  it.runIf(existsSync(purgePath))("inherits unsaved purge snapshots without duplicate injection or widened tools", async () => {
    const p = await parent(true);
    await p.session.prompt("/purge use minimal");
    const snapshot = captureNativeContext(p.api, p.ctx);
    expect(snapshot.purge).toBeDefined();
    await p.session.prompt("/purge off");
    const inherited = await p.run("snapshot task", { nativeContext: snapshot });
    const ordinary = await p.run("fresh task");
    expect(getCurrentSystemPrompt(p.requests[0].messages).match(/concise technical assistant/g)).toHaveLength(1);
    expect(getCurrentSystemPrompt(p.requests[1].messages)).not.toContain("concise technical assistant");
    expect(ordinary.responseText).toBe("finished");
    expect(inherited.session.getActiveToolNames()).toEqual(["read"]);
    const childTools = inherited.session.extensionRunner.createToolContext("scope-test", undefined);
    const blocked = await childTools.executeTool("write", { path: "must-not-exist.txt", content: "blocked" });
    expect(blocked.isError).toBe(true);
    expect(existsSync(join(root, "must-not-exist.txt"))).toBe(false);
  });

  it.runIf(existsSync(purgePath))("uses parent profile files but the actual worktree cwd", async () => {
    const p = await parent(true);
    const dir = join(root, ".pi", "pi-purge", "profiles"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "project.md"), "PROJECT_PROFILE working at {{cwd}}");
    await p.session.prompt("/purge use project");
    const worktree = join(root, "isolated-copy"); mkdirSync(worktree);
    writeFileSync(join(worktree, "child-only.txt"), "ACTUAL_CHILD_DIRECTORY");
    const result = await p.run("worktree task", { cwd: worktree, worktreeBase: root });
    expect(getCurrentSystemPrompt(p.requests[0].messages).replace(/\\/g, "/")).toContain(`PROJECT_PROFILE working at ${worktree.replace(/\\/g, "/")}`);
    expect(result.responseText).toBe("finished");
    const childTools = result.session.extensionRunner.createToolContext("cwd-test", undefined);
    const read = await childTools.executeTool("read", { path: "child-only.txt" });
    expect(read.isError).toBe(false);
    expect(JSON.stringify(read.result)).toContain("ACTUAL_CHILD_DIRECTORY");
  });

  it.runIf(existsSync(purgePath))("waits for independent purge continuations in concurrent sessions", async () => {
    const counts = new Map<string, number>();
    const p = await parent(true, context => {
      const user = context.messages.find(message => message.role === "user");
      const key = JSON.stringify(user);
      const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
      return count === 1 ? "我不能提供这类帮助。" : "finished after continuation";
    });
    await p.session.prompt("/purge use minimal");
    await p.session.prompt("/purge continue max 1");
    const results = await Promise.all([p.run("task A"), p.run("task B")]);
    expect(results.map(result => result.responseText)).toEqual(["finished after continuation", "finished after continuation"]);
    expect(p.requests).toHaveLength(4);
  });

  it.runIf(existsSync(purgePath))("freezes purge configuration before a spawn waits in the queue", async () => {
    let release!: (value: string) => void;
    const held = new Promise<string>(resolve => { release = resolve; });
    const p = await parent(true, () => held);
    const manager = new AgentManager();
    managers.push(manager);
    manager.setMaxConcurrent(1);
    await p.session.prompt("/purge use minimal");
    const options = { description: "queued fixture", isBackground: true };
    const first = manager.spawn(p.api, p.ctx, "ignored", "first", options);
    await manager.awaitStartup(first);
    const second = manager.spawn(p.api, p.ctx, "ignored", "second", options);
    expect(manager.getRecord(second)?.status).toBe("queued");
    await p.session.prompt("/purge off");
    release("finished");
    await manager.waitForAll();
    expect(manager.getRecord(second)?.status).toBe("completed");
    expect(p.requests).toHaveLength(2);
    for (const request of p.requests) expect(getCurrentSystemPrompt(request.messages)).toContain("concise technical assistant");
  });

  it.runIf(existsSync(purgePath))("stops an in-progress purge continuation without starting another one", async () => {
    let entered!: () => void;
    const continuationStarted = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    const p = await parent(true, () => {
      if (++calls === 1) return "我不能提供这类帮助。";
      entered();
      return new Promise<string>(() => {});
    });
    await p.session.prompt("/purge use minimal");
    await p.session.prompt("/purge continue max 2");
    const controller = new AbortController();
    const pending = p.run("cancelled task", { signal: controller.signal });
    await continuationStarted;
    controller.abort();
    const result = await pending;
    expect(result.session.isStreaming).toBe(false);
    expect(result.session.messages.filter(message => message.role === "assistant").at(-1)).toMatchObject({ stopReason: "aborted" });
    expect(p.requests).toHaveLength(2);
  });

  it("limits nested sessions to the immediate parent's tool scope and depth", async () => {
    const p = await parent();
    setNativeDelegation(true);
    const manager = new AgentManager();
    managers.push(manager);
    const child = await p.run("parent child", { nestedRuntime: { manager, parentAgentId: "owner", depth: 1, maxSubagentDepth: 2 } });
    const nestedAgent = child.session.getToolDefinition("Agent")!;
    expect(nestedAgent.parameters).not.toHaveProperty("properties.subagent_type");
    // Parent/root allows read, immediate child has relinquished every tool
    // except orchestration. The grandchild must not recover root's read tool.
    child.session.setActiveToolsByName(["Agent"]);
    const childCtx = child.session.extensionRunner.createToolContext("nested-fixture", undefined);
    const result = await nestedAgent.execute("nested", { prompt: "grandchild", description: "grandchild" }, undefined, undefined, childCtx);
    expect(JSON.stringify(result)).toContain("finished");
    const grandchildRequest = p.requests.at(-1)!;
    expect(getCurrentTools(grandchildRequest.messages)).toEqual([]);
  });

  it("runs workflow tasks and resumes without loading an agentType", async () => {
    const p = await parent();
    const manager = new AgentManager(); managers.push(manager);
    const result = await runWorkflow({
      script: `export const meta = { name: 'native-workflow', description: 'fixture' }; const a = await agent('workflow first', {label: 'first', agentType: 'ignored-role'}); const b = await agent('workflow resume', {resume: 'first'}); return [a,b];`,
      host: createWorkflowHost({ pi: p.api, ctx: p.ctx, manager, workflowId: "fixture" }),
    });
    expect(result.status).toBe("completed");
    expect(result.value).toEqual(["finished", "finished"]);
    expect(result.progress.filter(entry => entry.type === "workflow_agent").every(entry => entry.agentType === "pi")).toBe(true);
    expect(getCurrentSystemPrompt(p.requests[0].messages)).not.toContain("PERSONA_SENTINEL");
    expect(JSON.stringify(p.requests[1])).toContain("workflow first");
  });

  it("accepts RPC without a type and dispatches stored schedules without personas", async () => {
    const p = await parent();
    const reply = new Promise<{ success: boolean; data: { id: string } }>(resolve => {
      const off = p.api.events.on("subagents:rpc:spawn:reply:native-test", value => { off(); resolve(value as never); });
    });
    p.api.events.emit("subagents:rpc:spawn", { requestId: "native-test", prompt: "rpc task", options: { description: "rpc fixture", isBackground: true } });
    const response = await reply;
    expect(response.success).toBe(true);
    const collected = await p.session.getToolDefinition("get_subagent_result")!.execute("rpc-result", { agent_id: response.data.id, wait: true }, undefined, undefined, p.ctx);
    expect(JSON.stringify(collected)).toContain("finished");
    const manager = new AgentManager(); managers.push(manager);
    const scheduler = new SubagentScheduler();
    scheduler.start(p.api, p.ctx, manager, new ScheduleStore(join(root, "schedules.json")));
    try {
      const job = scheduler.addJob({ name: "native-schedule", description: "schedule fixture", schedule: "+1h", subagent_type: "obsolete-persona", prompt: "scheduled task" });
      // Fire the timer's callback directly so the offline test need not wait an hour.
      (scheduler as unknown as { executeJob(id: string): void }).executeJob(job.id);
      await manager.waitForAll();
      expect(p.requests).toHaveLength(2);
      expect(JSON.stringify(p.requests[1])).toContain("scheduled task");
      expect(getCurrentSystemPrompt(p.requests[1].messages)).not.toContain("PERSONA_SENTINEL");
    } finally { scheduler.stop(); }
  });

  it("forks a persisted child when a different parent reopens it", async () => {
    const p = await parent();
    setRememberAgents(true);
    let owner = join(root, "parent-one.jsonl");
    const ctx = { ...p.ctx, sessionManager: Object.assign(Object.create(p.ctx.sessionManager), { getSessionFile: () => owner }) };
    const options = { pi: p.api, onSessionCreated: (session: AgentSession) => sessions.push(session) };
    const first = await runAgent(ctx, "pi", "saved task", options);
    const originalFile = first.session.sessionManager.getSessionFile()!;
    const original = readFileSync(originalFile, "utf8");
    owner = join(root, "parent-two.jsonl");
    const second = await runAgent(ctx, "pi", "continued task", { ...options, resumeSessionFile: originalFile });
    expect(second.session.sessionManager.getSessionFile()).not.toBe(originalFile);
    expect(second.session.sessionManager.getHeader()?.parentSession).toBe(originalFile);
    expect(readFileSync(originalFile, "utf8")).toBe(original);
    expect(JSON.stringify(p.requests.at(-1))).toContain("saved task");
    const forkFile = second.session.sessionManager.getSessionFile()!;
    const third = await runAgent(ctx, "pi", "same parent again", { ...options, resumeSessionFile: forkFile });
    expect(third.session.sessionManager.getSessionFile()).toBe(forkFile);
  });

  it.runIf(existsSync(purgePath))("reports a missing inherited purge extension instead of silently losing the snapshot", async () => {
    const p = await parent(true);
    const snapshot = captureNativeContext(p.api, p.ctx);
    snapshot.purge!.extensionPath = join(root, "missing-purge.ts");
    await expect(p.run("must inherit", { nativeContext: snapshot })).rejects.toThrow("Could not load inherited pi-purge");
    expect(p.requests).toHaveLength(0);
  });
});
