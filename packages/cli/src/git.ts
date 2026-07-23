import type { ProjectContext } from "./types";
import { runCommand } from "./process";

export interface GitMetadata {
  ref: string;
  sha: string;
  githubOwner: string;
}

async function gitValue(
  context: ProjectContext,
  args: string[],
): Promise<string | null> {
  const result = await runCommand("git", args, { cwd: context.root });
  return result.code === 0 && result.stdout ? result.stdout.trim() : null;
}

export async function resolveGitMetadata(
  context: ProjectContext,
): Promise<GitMetadata> {
  const ref =
    process.env.REF_TAG?.trim() ||
    process.env.GITHUB_REF_NAME?.trim() ||
    (await gitValue(context, ["rev-parse", "--abbrev-ref", "HEAD"])) ||
    "unknown";
  const sha =
    process.env.SHA_TAG?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    (await gitValue(context, ["rev-parse", "HEAD"])) ||
    "unknown";
  const githubOwner =
    process.env.GITHUB_REPOSITORY_OWNER?.trim() ||
    process.env.GHCR_OWNER?.trim() ||
    "unknown";
  return { ref, sha, githubOwner };
}
