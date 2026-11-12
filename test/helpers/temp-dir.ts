import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";

/** Let Windows release SDK subprocess handles before retrying fixture removal. */
export async function removeTempDir(path: string): Promise<void> {
  const target = resolve(path);
  if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error(`Not a temporary fixture: ${target}`);
  await rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
