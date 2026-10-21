import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

// Opt-in integration test: uses only its own temporary project, containers and volume.
const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cli = path.join(repository, "packages/cli/dist/index.js");
const image = "node:22-alpine";
const run = async (command, args, cwd = repository) =>
  await new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({
          code: error?.code ?? 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      },
    );
  });
const checked = async (command, args, cwd) => {
  const result = await run(command, args, cwd);
  assert.equal(
    result.code,
    0,
    `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
  return result;
};
await checked("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
await readFile(cli); // Build first; do not fall back to an installed/released CLI.
const root = await mkdtemp(path.join(os.tmpdir(), "papucs-lifecycle-"));
const projectName = `lifecycle-smoke-${path.basename(root).slice("papucs-lifecycle-".length).toLowerCase()}`;
let composeProject;
const papucs = async (...args) =>
  await run(process.execPath, [cli, "--project", root, ...args]);
const papucsJson = async (...args) => {
  const result = await papucs(...args, "--json");
  assert.equal(
    result.code,
    0,
    `${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  return envelope.data;
};
const writeJson = async (relative, value) => {
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`);
};
const fingerprint = async (relative) =>
  createHash("sha256")
    .update(await readFile(path.join(root, relative)))
    .digest("hex");
const containerIds = async () =>
  (
    await checked("docker", [
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${composeProject}`,
      "--format",
      "{{.ID}}",
    ])
  ).stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();

try {
  await writeJson("papucs.yml", {
    version: 1,
    project: projectName,
    runtime: { dir: ".runtime" },
    sources: { layers: "layers", servers: "servers" },
    compose: {
      file: "docker-compose.yml",
      shared_server_template: "servers/_template/app.yml",
    },
    build: {
      dockerfile_template: "Dockerfile",
      image: "example/%server_type%",
      tags: ["%sha%"],
    },
    preserve_paths: [],
    replaceable_text_extensions: [".yml"],
  });
  await writeJson("layers/base/_layer.yml", { name: "base" });
  await writeFile(
    path.join(root, "layers/base/server.js"),
    "console.log('ready:' + process.env.TEST_PASSWORD); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);\n",
  );
  await writeFile(
    path.join(root, ".env"),
    "TEST_PASSWORD=fixture-secret-value\n",
  );
  await mkdir(path.join(root, "control"));
  const infrastructure = {
    services: {
      store: {
        image,
        command: [
          "node",
          "-e",
          "console.log('ready'); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000)",
        ],
        stop_grace_period: "2s",
        volumes: ["store-data:/data"],
        healthcheck: {
          test: ["CMD", "node", "-e", "process.exit(0)"],
          interval: "1s",
          timeout: "1s",
          retries: 10,
        },
      },
      stubborn: {
        image,
        command: [
          "node",
          "-e",
          "console.log('ready'); process.on('SIGTERM',()=>{if(require('fs').existsSync('/control/clean'))process.exit(0)}); setInterval(()=>{},1000)",
        ],
        stop_grace_period: "1s",
        depends_on: ["store"],
        volumes: ["./control:/control:ro"],
      },
    },
    volumes: { "store-data": {} },
  };
  await writeJson("docker-compose.yml", infrastructure);
  const template = {
    services: {
      app: {
        image,
        command: ["node", "server.js"],
        working_dir: "/data",
        volumes: ["${PAPUCS_DATA_PATH}:/data"],
        environment: { TEST_PASSWORD: "${TEST_PASSWORD}" },
        stop_grace_period: "2s",
        restart: "unless-stopped",
        depends_on: {
          store: { condition: "service_healthy" },
          stubborn: { condition: "service_started" },
        },
      },
    },
  };
  await writeJson("servers/_template/app.yml", template);
  for (const type of ["proxy", "backend"]) {
    await writeJson(`servers/${type}/${type}.yml`, {
      name: type,
      image,
      compose_service: "app",
      instance_name: "%project%-%server_type%-%index%",
      papucs_port_base: type === "proxy" ? 26000 : 27000,
      layers: ["base"],
      ...(type === "backend"
        ? { depends_on: [{ server: "proxy", condition: "service_started" }] }
        : {}),
    });
  }
  await papucsJson("config", "validate");
  composeProject = (await papucsJson("stopall", "--dry-run"))
    .composeProjectName;
  assert.ok(composeProject.startsWith(`papucs-${projectName}-`));
  assert.equal(await stat(path.join(root, ".runtime")).catch(() => null), null);
  const up = await papucs("up", "backend", "proxy");
  assert.equal(up.code, 0, `${up.stdout}\n${up.stderr}`);
  const ids = await containerIds();
  assert.equal(ids.length, 4);
  const startedDeadline = Date.now() + 15000;
  while (true) {
    const logs = await Promise.all(
      ids.map(async (id) => (await checked("docker", ["logs", id])).stdout),
    );
    if (logs.every((log) => log.includes("ready"))) break;
    assert.ok(
      Date.now() < startedDeadline,
      "fixture processes failed to become ready",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await writeFile(
    path.join(root, ".runtime/instances/backend-1/data/sentinel.txt"),
    "runtime-only data\n",
  );
  const protectedFiles = [
    ".runtime/state.json",
    ".runtime/docker-compose.yml",
    ".runtime/cache/backend-1.json",
    ".runtime/instances/backend-1/data/sentinel.txt",
  ];
  const before = await Promise.all(protectedFiles.map(fingerprint));

  await writeFile(path.join(root, "control/clean"), "allow graceful stop\n");
  await checked("docker", ["stop", ...ids]);
  const start = await papucsJson("start", "backend-1", "--wait-timeout", "15");
  assert.deepEqual(start.layers, [
    ["store"],
    ["stubborn"],
    ["proxy-1"],
    ["backend-1"],
  ]);
  assert.equal(start.started.length, 4);
  assert.deepEqual(await containerIds(), ids);
  assert.deepEqual(await Promise.all(protectedFiles.map(fingerprint)), before);
  assert.equal((await papucsJson("start", "backend-1")).started.length, 0);
  console.log(
    "PASS start: dependency readiness, unchanged IDs/runtime/state/cache, idempotence",
  );

  template.services.app.stop_grace_period = "15s";
  infrastructure.services.store.stop_grace_period = "9s";
  await writeJson("servers/_template/app.yml", template);
  await writeJson("docker-compose.yml", infrastructure);
  const plan = await papucsJson("stopall", "--dry-run");
  assert.deepEqual(plan.stopLayers, [
    ["backend-1"],
    ["proxy-1"],
    ["stubborn"],
    ["store"],
  ]);
  for (const service of ["backend-1", "proxy-1", "store"]) {
    const diff = plan.lifecycleDiffs.find((entry) => entry.service === service);
    assert.ok(diff.sourceDiffersFromGenerated.includes("stopTimeoutSeconds"));
  }
  const diagnosis = await papucsJson("diagnose", "backend-1");
  assert.ok(
    diagnosis.containers[0].logs.some((line) => line.includes("[REDACTED]")),
  );
  assert.ok(!JSON.stringify(diagnosis).includes("fixture-secret-value"));
  assert.deepEqual(await Promise.all(protectedFiles.map(fingerprint)), before);
  console.log(
    "PASS read-only plan/diagnose: source drift, dependency order, log redaction, no runtime writes",
  );

  await rm(path.join(root, "control/clean"));
  const failed = await papucs("stopall", "--json");
  assert.equal(failed.code, 1);
  const error = JSON.parse(failed.stdout).error;
  assert.match(error.message, /did not stop cleanly/);
  const evidence = error.diagnostics.containers.find(
    (entry) => entry.snapshot.service === "stubborn",
  );
  assert.equal(evidence.snapshot.exitCode, 137);
  assert.ok(
    evidence.events.some(
      (event) =>
        event.action === "kill" && ["9", "SIGKILL"].includes(event.signal),
    ),
  );
  const blocked = await papucs("stopall", "--dry-run", "--json");
  assert.equal(blocked.code, 1);
  assert.equal(JSON.parse(blocked.stdout).ok, false);
  const storeId = (
    await checked("docker", [
      "ps",
      "--filter",
      `label=com.docker.compose.project=${composeProject}`,
      "--filter",
      "label=com.docker.compose.service=store",
      "--format",
      "{{.ID}}",
    ])
  ).stdout;
  assert.ok(
    storeId,
    "provider must remain running after consumer stop failure",
  );
  assert.deepEqual(await Promise.all(protectedFiles.map(fingerprint)), before);
  console.log(
    "PASS stop failure: exit137/SIGKILL evidence, blocked plan, provider/state retained",
  );

  await writeFile(path.join(root, "control/clean"), "allow graceful stop\n");
  const recovered = await papucsJson(
    "start",
    "backend-1",
    "--wait-timeout",
    "15",
  );
  assert.ok(recovered.started.includes("stubborn"));
  assert.deepEqual(await containerIds(), ids);
  const finalStop = await papucsJson("stopall");
  assert.equal(finalStop.stopped, true);
  assert.equal((await containerIds()).length, 0);
  const state = JSON.parse(
    await readFile(path.join(root, ".runtime/state.json"), "utf8"),
  );
  assert.equal(state.instances.length, 0);
  assert.equal((await readdir(path.join(root, ".runtime/cache"))).length, 0);
  assert.equal(await fingerprint(protectedFiles.at(-1)), before.at(-1));
  const volumes = await checked("docker", [
    "volume",
    "ls",
    "--filter",
    `label=com.docker.compose.project=${composeProject}`,
    "--format",
    "{{.Name}}",
  ]);
  assert.ok(volumes.stdout.includes("store-data"));
  console.log(
    "PASS recovery and complete stopall: same containers, data retained, cleanup complete, volume retained",
  );
} finally {
  if (
    composeProject?.startsWith(`papucs-${projectName}-`) &&
    (await stat(path.join(root, ".runtime/docker-compose.yml")).catch(
      () => null,
    ))
  ) {
    const cleanup = await run("docker", [
      "compose",
      "--project-name",
      composeProject,
      "--env-file",
      path.join(root, ".env"),
      "-f",
      path.join(root, ".runtime/docker-compose.yml"),
      "down",
      "--remove-orphans",
      "--volumes",
    ]);
    assert.equal(
      cleanup.code,
      0,
      `Test fixture cleanup failed: ${cleanup.stderr}`,
    );
  }
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith("papucs-lifecycle-"));
  await rm(resolved, { recursive: true, force: true });
}
