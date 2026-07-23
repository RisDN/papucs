import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveProjectContext } from "./context";
import { collectSourceManifest, parseLayerConfigEntry } from "./manifest";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "papucs-manifest-"));
  const files: Record<string, string> = {
    "papucs.yml": `version: 1
project: manifest-test
runtime: { dir: .runtime }
sources: { layers: layers, servers: servers }
compose:
  file: docker-compose.yml
  shared_server_template: servers/_template/minecraft-server-base.yml
build:
  dockerfile_template: Dockerfile.template
  image: example/%server_type%
  tags: ["%ref%"]
preserve_paths: []
replaceable_text_extensions: [.yml]
`,
    "layers/base/_layer.yml": "name: base\n",
    "layers/base/config.yml": "source: base\n",
    "layers/dev/_layer.yml": "name: dev\n",
    "layers/dev/config.yml": "source: dev\n",
    "servers/spawn/spawn.yml": `name: spawn
image: example/server
compose_service: app
instance_name: "%project%-%server_type%-%index%"
layers: [base, "dev --skip-build"]
`,
    "servers/spawn/data/config.yml": "source: server\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

describe("source manifest", () => {
  test("parses layer flags and rejects unsupported arguments", () => {
    expect(parseLayerConfigEntry("dev --skip-build")).toEqual({
      name: "dev",
      skipBuild: true,
    });
    expect(() => parseLayerConfigEntry("dev --unknown")).toThrow(
      "Unsupported layer arguments",
    );
  });

  test("merges layers and server data deterministically", async () => {
    const context = await resolveProjectContext({ project: await fixture() });
    const manifest = await collectSourceManifest(context, "spawn");
    expect(manifest.files.get("config.yml")?.source).toBe("data:spawn");
    expect(manifest.overrides).toHaveLength(2);
  });

  test("omits skip-build layers only during build", async () => {
    const context = await resolveProjectContext({ project: await fixture() });
    const runtime = await collectSourceManifest(context, "spawn");
    const build = await collectSourceManifest(context, "spawn", {
      skipBuildLayers: true,
    });
    expect(runtime.overrides.some((entry) => entry.to === "layer:dev")).toBe(
      true,
    );
    expect(build.overrides.some((entry) => entry.to === "layer:dev")).toBe(
      false,
    );
  });
});
