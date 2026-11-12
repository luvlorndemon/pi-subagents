import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inChildSessionContext } from "./child-context.js";
import subagents from "./index.js";
import { setNativeDelegation, setNativeSessionMode } from "./native-mode.js";

/** No persona registry: this entry creates ordinary pi sessions for tasks. */
export default function nativeSubagents(pi: ExtensionAPI): void {
  if (inChildSessionContext()) return;
  setNativeSessionMode(true);
  setNativeDelegation(false);
  subagents(pi);
}
