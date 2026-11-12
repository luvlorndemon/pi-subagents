import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Versioned, in-process bridge shared with pi-purge; never copies prompts. */
export interface PurgeSnapshot {
  version: 1;
  config: unknown;
  source: unknown;
  configRoot: string;
  extensionPath: string;
}
export interface NativeSpawnContext {
  purge?: PurgeSnapshot;
}
const REGISTRY = Symbol.for("pi-purge:session-snapshots:v1");
const CHILD = Symbol.for("pi-subagents:native-child-context:v1");
const shared = globalThis as typeof globalThis & { [key: symbol]: unknown };
shared[CHILD] ??= new AsyncLocalStorage<NativeSpawnContext>();
const childContext = shared[CHILD] as AsyncLocalStorage<NativeSpawnContext>;

export function captureNativeContext(ctx: ExtensionContext): NativeSpawnContext {
  const providers = shared[REGISTRY] as Map<string, () => PurgeSnapshot> | undefined;
  const purge = providers?.get(ctx.sessionManager.getSessionId())?.();
  return {
    ...(purge ? { purge: structuredClone(purge) } : {}),
  };
}

export function withNativeContext<T>(context: NativeSpawnContext, action: () => Promise<T>): Promise<T> {
  return childContext.run(context, action);
}
