import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const allowed = [
  /^(0BSD|Apache-2\.0|BSD-[23]-Clause|ISC|MIT|MPL-2\.0|Python-2\.0)$/,
  /^BlueOak-/,
  /^\(MIT OR Apache-2\.0\)$/,
  /MIT/,
  /BSD/,
];
const nodeModules = path.join(process.cwd(), "node_modules");
const failures = [];

for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }
  const directories = entry.name.startsWith("@")
    ? (
        await readdir(path.join(nodeModules, entry.name), {
          withFileTypes: true,
        })
      )
        .filter((child) => child.isDirectory())
        .map((child) => path.join(nodeModules, entry.name, child.name))
    : [path.join(nodeModules, entry.name)];

  for (const directory of directories) {
    const manifestPath = path.join(directory, "package.json");
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const license =
      typeof manifest.license === "string" ? manifest.license : "UNKNOWN";
    if (!allowed.some((pattern) => pattern.test(license))) {
      failures.push(`${manifest.name ?? directory}: ${license}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Unapproved dependency licenses:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Dependency license audit passed.");
}
