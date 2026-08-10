import { resolveInstanceExact } from "../compose";
import { PapucsError } from "../errors";
import { runCommand } from "../process";
import { loadState } from "../state";
import type { ProjectContext } from "../types";

export async function commandAttach(
  context: ProjectContext,
  target: string,
): Promise<void> {
  const state = await loadState(context);
  const instance = resolveInstanceExact(state, target);
  const result = await runCommand("docker", ["attach", instance.serverName], {
    cwd: context.root,
    stream: true,
  });
  if (result.code !== 0) {
    throw new PapucsError(`docker attach ${instance.serverName} failed.`);
  }
}
