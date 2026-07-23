import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PapucsError } from "../errors";
import { atomicWriteFile, ensureDir } from "../fs";
import type { ProjectContext, Reporter } from "../types";

const workflow = `name: Papucs Build

on:
  push:
    branches: ["main"]
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
      - run: npx papucs build --actions --push --json
`;

export async function commandWorkflowAdd(
  context: ProjectContext,
  name: string,
  options: { dryRun: boolean; force: boolean },
  reporter: Reporter,
): Promise<{ path: string; changed: boolean; content: string }> {
  if (name !== "ghcr-build") {
    throw new PapucsError(
      `Unknown workflow '${name}'. Available: ghcr-build.`,
      2,
    );
  }
  const target = path.join(
    context.root,
    ".github",
    "workflows",
    "papucs-build.yml",
  );
  if (existsSync(target)) {
    const existing = await readFile(target, "utf8");
    if (existing === workflow) {
      reporter.log("GHCR build workflow is already up-to-date.");
      return { path: target, changed: false, content: workflow };
    }
    if (!options.force) {
      throw new PapucsError(
        `Workflow already exists: ${target}. Use --force to overwrite.`,
      );
    }
  }
  if (!options.dryRun) {
    await ensureDir(path.dirname(target));
    await atomicWriteFile(target, workflow);
  }
  reporter.log(
    `${options.dryRun ? "Would write" : "Wrote"} ${path.relative(context.root, target)}.`,
  );
  return { path: target, changed: true, content: workflow };
}
