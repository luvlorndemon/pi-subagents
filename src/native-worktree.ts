import { isAbsolute } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** Session metadata, not a model message. Survives record eviction and reload. */
export const NATIVE_WORKTREE_ENTRY = "pi-subagents:native-worktree";
export interface NativeWorktreeState {
  sourceCwd: string;
  complete: boolean;
  hasChanges?: boolean;
  branch?: string;
}

export function readNativeWorktree(manager: SessionManager): NativeWorktreeState | undefined {
  const entry = manager.getBranch().slice().reverse().find(item => item.type === "custom" && item.customType === NATIVE_WORKTREE_ENTRY);
  if (entry?.type !== "custom") return undefined;
  const value = entry.data as Partial<NativeWorktreeState> | undefined;
  if (!value || typeof value.sourceCwd !== "string" || !isAbsolute(value.sourceCwd)) throw new Error("Invalid worktree resume metadata.");
  if (value.complete !== true) throw new Error("Cannot resume: worktree cleanup did not finish.");
  if (value.hasChanges !== false) throw new Error(`Cannot resume: its worktree no longer exists.${value.branch ? ` Changes are saved on branch ${value.branch}.` : ""}`);
  return value as NativeWorktreeState;
}
