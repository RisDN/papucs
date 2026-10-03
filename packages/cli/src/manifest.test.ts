import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveProjectContext } from "./context";
import { collectSourceManifest, parseLayerConfigEntry } from "./manifest";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function serverConfig(layers: string[]): string {
  return JSON.stringify({
    name: "spawn",
    image: "example/server",
    compose_service: "app",
    instance_name: "%project%-%server_type%-%index%",
    papucs_port_base: 25565,
    layers,
  });
}

async function fixture(
  overrides: Record<string, string | null> = {},
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "papucs-manifest-"));
  directories.push(root);
  const files: Record<string, string | null> = {
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
    "servers/spawn/spawn.yml": serverConfig(["base", "dev --skip-build"]),
    "servers/spawn/data/config.yml": "source: server\n",
    ...overrides,
  };
  for (const [relative, content] of Object.entries(files)) {
    if (content === null) {
      continue;
    }
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

  test("merges nested layers depth-first, followed by the parent, siblings, and server data", async () => {
    const root = await fixture({
      "layers/base/_layer.yml": "name: base\nlayers: [middle]\n",
      "layers/middle/_layer.yml": "name: middle\nlayers: [deep]\n",
      "layers/middle/config.yml": "source: middle\n",
      "layers/middle/parent.yml": "source: middle\n",
      "layers/deep/_layer.yml": "name: deep\n",
      "layers/deep/config.yml": "source: deep\n",
      "layers/deep/parent.yml": "source: deep\n",
      "layers/deep/plugins/example/settings.yml": "enabled: true\n",
      "layers/base/parent.yml": "source: base\n",
      "layers/base/sibling.yml": "source: base\n",
      "layers/dev/sibling.yml": "source: dev\n",
    });
    const context = await resolveProjectContext({ project: root });
    const manifest = await collectSourceManifest(context, "spawn");

    expect(manifest.files.get("config.yml")?.source).toBe("data:spawn");
    expect(manifest.files.get("parent.yml")?.source).toBe("layer:base");
    expect(manifest.files.get("sibling.yml")?.source).toBe("layer:dev");
    expect(
      manifest.overrides.filter(({ relPath }) => relPath === "config.yml"),
    ).toEqual([
      { relPath: "config.yml", from: "layer:deep", to: "layer:middle" },
      { relPath: "config.yml", from: "layer:middle", to: "layer:base" },
      { relPath: "config.yml", from: "layer:base", to: "layer:dev" },
      { relPath: "config.yml", from: "layer:dev", to: "data:spawn" },
    ]);
    const nestedFile = manifest.files.get("plugins/example/settings.yml");
    expect(nestedFile).toMatchObject({
      source: "layer:deep",
      absPath: path.join(root, "layers/deep/plugins/example/settings.yml"),
    });
    expect(await readFile(nestedFile!.absPath, "utf8")).toBe("enabled: true\n");
    expect([...manifest.files.keys()].sort()).toEqual([
      "config.yml",
      "parent.yml",
      "plugins/example/settings.yml",
      "sibling.yml",
    ]);
    expect(
      manifest.overrides.some(({ relPath }) => relPath === "_layer.yml"),
    ).toBe(false);
  });

  test("applies child layers in their listed order even when the parent has no files", async () => {
    const context = await resolveProjectContext({
      project: await fixture({
        "servers/spawn/spawn.yml": serverConfig(["bundle"]),
        "servers/spawn/data/config.yml": null,
        "layers/bundle/_layer.yml": "name: bundle\nlayers: [base, dev]\n",
      }),
    });
    const manifest = await collectSourceManifest(context, "spawn");

    expect(manifest.files.get("config.yml")?.source).toBe("layer:dev");
    expect(manifest.overrides).toEqual([
      { relPath: "config.yml", from: "layer:base", to: "layer:dev" },
    ]);
  });

  test("accepts an empty child list and preserves additional layer metadata", async () => {
    const context = await resolveProjectContext({
      project: await fixture({
        "servers/spawn/spawn.yml": serverConfig(["base"]),
        "servers/spawn/data/config.yml": null,
        "layers/base/_layer.yml":
          "name: base\nlayers: []\ndescription: Shared files\n",
      }),
    });
    const manifest = await collectSourceManifest(context, "spawn");

    expect(manifest.files.get("config.yml")?.source).toBe("layer:base");
    expect(manifest.files.has("_layer.yml")).toBe(false);
  });

  test("reapplies shared dependencies and repeated roots in configured order", async () => {
    const context = await resolveProjectContext({
      project: await fixture({
        "servers/spawn/spawn.yml": serverConfig(["left", "right", "left"]),
        "servers/spawn/data/config.yml": null,
        "layers/left/_layer.yml": "name: left\nlayers: [base]\n",
        "layers/left/config.yml": "source: left\n",
        "layers/right/_layer.yml": "name: right\nlayers: [base]\n",
        "layers/right/config.yml": "source: right\n",
      }),
    });
    const manifest = await collectSourceManifest(context, "spawn");

    expect(manifest.files.get("config.yml")?.source).toBe("layer:left");
    expect(manifest.overrides).toEqual([
      { relPath: "config.yml", from: "layer:base", to: "layer:left" },
      { relPath: "config.yml", from: "layer:left", to: "layer:base" },
      { relPath: "config.yml", from: "layer:base", to: "layer:right" },
      { relPath: "config.yml", from: "layer:right", to: "layer:base" },
      { relPath: "config.yml", from: "layer:base", to: "layer:left" },
    ]);
  });

  test("skips the full nested skip-build subtree while retaining its parent and siblings", async () => {
    const context = await resolveProjectContext({
      project: await fixture({
        "servers/spawn/spawn.yml": serverConfig(["base"]),
        "layers/base/_layer.yml":
          'name: base\nlayers: ["  dev   --skip-build  ", release]\n',
        "layers/base/base.txt": "base\n",
        "layers/dev/_layer.yml": "name: dev\nlayers: [deep]\n",
        "layers/dev/dev.txt": "dev\n",
        "layers/deep/_layer.yml": "name: deep\n",
        "layers/deep/deep.txt": "deep\n",
        "layers/release/_layer.yml": "name: release\n",
        "layers/release/release.txt": "release\n",
      }),
    });
    const runtime = await collectSourceManifest(context, "spawn");
    const build = await collectSourceManifest(context, "spawn", {
      skipBuildLayers: true,
    });

    expect(runtime.files.get("deep.txt")?.source).toBe("layer:deep");
    expect(runtime.files.get("dev.txt")?.source).toBe("layer:dev");
    expect([...build.files.keys()].sort()).toEqual([
      "base.txt",
      "config.yml",
      "release.txt",
    ]);
    expect(build.files.get("base.txt")?.source).toBe("layer:base");
    expect(build.files.get("release.txt")?.source).toBe("layer:release");
  });

  test("includes an independently referenced child of a skipped root during build", async () => {
    const context = await resolveProjectContext({
      project: await fixture({
        "servers/spawn/spawn.yml": serverConfig(["base --skip-build", "deep"]),
        "layers/base/_layer.yml": "name: base\nlayers: [dev]\n",
        "layers/base/base.txt": "base\n",
        "layers/dev/_layer.yml": "name: dev\nlayers: [deep]\n",
        "layers/dev/dev.txt": "dev\n",
        "layers/deep/_layer.yml": "name: deep\n",
        "layers/deep/deep.txt": "deep\n",
      }),
    });
    const runtime = await collectSourceManifest(context, "spawn");
    const build = await collectSourceManifest(context, "spawn", {
      skipBuildLayers: true,
    });

    expect(runtime.files.get("base.txt")?.source).toBe("layer:base");
    expect(runtime.files.get("dev.txt")?.source).toBe("layer:dev");
    expect(runtime.files.get("deep.txt")?.source).toBe("layer:deep");
    expect([...build.files.keys()].sort()).toEqual(["config.yml", "deep.txt"]);
    expect(build.files.get("deep.txt")?.source).toBe("layer:deep");
  });

  test.each<{
    name: string;
    metadata: Record<string, string>;
    message: string;
  }>([
    {
      name: "direct",
      metadata: {
        "layers/base/_layer.yml": "name: base\nlayers: [base]\n",
      },
      message: "Circular layer reference: base -> base.",
    },
    {
      name: "transitive",
      metadata: {
        "layers/base/_layer.yml": "name: base\nlayers: [middle]\n",
        "layers/middle/_layer.yml": "name: middle\nlayers: [deep]\n",
        "layers/deep/_layer.yml": "name: deep\nlayers: [base]\n",
      },
      message: "Circular layer reference: base -> middle -> deep -> base.",
    },
  ])(
    "rejects $name cycles with their reference path",
    async ({ metadata, message }) => {
      const context = await resolveProjectContext({
        project: await fixture(metadata),
      });

      await expect(
        collectSourceManifest(context, "spawn"),
      ).rejects.toMatchObject({
        name: "PapucsError",
        message,
      });
    },
  );

  test("does not traverse a skipped cyclic reference during build", async () => {
    const context = await resolveProjectContext({
      project: await fixture({
        "servers/spawn/spawn.yml": serverConfig(["base"]),
        "layers/base/_layer.yml": 'name: base\nlayers: ["base --skip-build"]\n',
      }),
    });

    await expect(collectSourceManifest(context, "spawn")).rejects.toThrow(
      "Circular layer reference: base -> base.",
    );
    const build = await collectSourceManifest(context, "spawn", {
      skipBuildLayers: true,
    });
    expect(build.overrides).toEqual([
      { relPath: "config.yml", from: "layer:base", to: "data:spawn" },
    ]);
  });

  test.each(
    [
      null,
      "dev",
      42,
      { name: "dev" },
      [42],
      [true],
      [null],
      [{}],
      [""],
      ["   "],
    ].map((layers) => ({ layers })),
  )(
    "rejects malformed nested layer lists with the metadata path: $layers",
    async ({ layers }) => {
      const root = await fixture({
        "layers/base/_layer.yml": JSON.stringify({ name: "base", layers }),
      });
      const context = await resolveProjectContext({ project: root });
      const metadataPath = path.join(root, "layers/base/_layer.yml");

      await expect(
        collectSourceManifest(context, "spawn"),
      ).rejects.toMatchObject({
        name: "PapucsError",
        message: expect.stringContaining(
          `Invalid configuration '${metadataPath}': layers`,
        ),
      });
    },
  );

  test.each([
    ["../outside", "Layer name must match"],
    ["/outside", "Layer name must match"],
    ["dev --unknown", "Unsupported layer arguments for 'dev': --unknown."],
  ])("rejects invalid nested layer reference %s", async (entry, message) => {
    const context = await resolveProjectContext({
      project: await fixture({
        "layers/base/_layer.yml": JSON.stringify({
          name: "base",
          layers: [entry],
        }),
      }),
    });

    await expect(collectSourceManifest(context, "spawn")).rejects.toThrow(
      message,
    );
  });

  test("reports missing metadata for a nested layer", async () => {
    const root = await fixture({
      "layers/base/_layer.yml": "name: base\nlayers: [child]\n",
      "layers/child/config.yml": "source: child\n",
    });
    const context = await resolveProjectContext({ project: root });

    await expect(collectSourceManifest(context, "spawn")).rejects.toThrow(
      `Layer 'child' is missing mandatory metadata: ${path.join(root, "layers/child/_layer.yml")}`,
    );
  });

  test("reports a mismatched nested metadata name", async () => {
    const root = await fixture({
      "layers/base/_layer.yml": "name: base\nlayers: [child]\n",
      "layers/child/_layer.yml": "name: other\n",
    });
    const context = await resolveProjectContext({ project: root });

    await expect(collectSourceManifest(context, "spawn")).rejects.toThrow(
      `Layer metadata name must equal folder name 'child': ${path.join(root, "layers/child/_layer.yml")}`,
    );
  });

  test.each(["description: Missing name\n", "name: 42\n"])(
    "rejects invalid nested metadata names: %j",
    async (metadata) => {
      const root = await fixture({
        "layers/base/_layer.yml": "name: base\nlayers: [child]\n",
        "layers/child/_layer.yml": metadata,
      });
      const context = await resolveProjectContext({ project: root });

      await expect(collectSourceManifest(context, "spawn")).rejects.toThrow(
        `Invalid configuration '${path.join(root, "layers/child/_layer.yml")}': name`,
      );
    },
  );
});
