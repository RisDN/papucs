import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  findProjectConfig,
  resolveInsideRoot,
  resolveProjectContext,
} from "./context";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "papucs-context-"));
  await writeFile(
    path.join(root, "papucs.yml"),
    `version: 1
project: context-test
runtime: { dir: .runtime }
sources: { layers: layers, servers: servers }
compose:
  file: docker-compose.yml
  shared_server_template: servers/_template/minecraft-server-base.yml
build:
  dockerfile_template: Dockerfile.template
  image: example/%server_type%
  tags: ["%ref%"]
preserve_paths: [libraries]
replaceable_text_extensions: [.yml]
`,
    "utf8",
  );
  return root;
}

describe("project context", () => {
  test("discovers papucs.yml from a nested directory", async () => {
    const root = await fixture();
    const nested = path.join(root, "one", "two");
    await mkdir(nested, { recursive: true });

    expect(findProjectConfig(nested)).toBe(path.join(root, "papucs.yml"));
    const context = await resolveProjectContext({ cwd: nested });
    expect(context.root).toBe(root);
    expect(context.runtimeRoot).toBe(path.join(root, ".runtime"));
    expect(context.composeProjectName).toMatch(/^papucs-context-test-/);
  });

  test("honors explicit config before discovery", async () => {
    const root = await fixture();
    const context = await resolveProjectContext({
      cwd: os.tmpdir(),
      config: path.join(root, "papucs.yml"),
    });
    expect(context.config.project).toBe("context-test");
  });

  test("rejects paths outside project root", async () => {
    const root = await fixture();
    expect(() => resolveInsideRoot(root, "../secret", "test")).toThrow(
      "escapes the project root",
    );
    expect(() => resolveInsideRoot(root, path.resolve(root), "test")).toThrow(
      "must be relative",
    );
  });
});
