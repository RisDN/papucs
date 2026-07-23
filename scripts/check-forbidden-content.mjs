import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const ignoredDirectories = new Set([
  ".git",
  ".papucs-smoke",
  "coverage",
  "dist",
  "node_modules",
]);
const forbiddenExtensions = new Set([
  ".bbmodel",
  ".dat",
  ".jar",
  ".mca",
  ".schem",
]);
const forbiddenText = ["fantasy" + "block", "fantasy" + "dream"];
const failures = [];
const stack = [root];

while (stack.length > 0) {
  const directory = stack.pop();
  if (!directory) {
    continue;
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      stack.push(absolute);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const relative = path.relative(root, absolute);
    const extension = path.extname(entry.name).toLowerCase();
    if (forbiddenExtensions.has(extension)) {
      failures.push(`${relative}: forbidden binary/asset extension`);
      continue;
    }
    const content = await readFile(absolute);
    if (content.includes(0)) {
      continue;
    }
    const text = content.toString("utf8").toLowerCase();
    for (const term of forbiddenText) {
      if (text.includes(term)) {
        failures.push(`${relative}: contains forbidden private branding`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Content audit passed.");
}
