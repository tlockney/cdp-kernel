// Tests that need a real Bun skip when it isn't installed. CI installs it,
// so there they always run.
import { spawnSync } from "node:child_process";

let found: boolean | undefined;

export function hasBun(): boolean {
  found ??= spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
  return found;
}
