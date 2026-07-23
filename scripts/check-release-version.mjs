import { readFile } from "node:fs/promises";
import process from "node:process";

const requested = (
  process.argv[2] ??
  process.env.GITHUB_REF_NAME ??
  ""
).replace(/^v/, "");
if (!requested) {
  console.error("Release version is required as vX.Y.Z or X.Y.Z.");
  process.exitCode = 1;
} else {
  const manifests = [
    "package.json",
    "packages/cli/package.json",
    "packages/create-papucs/package.json",
  ];
  const mismatches = [];
  for (const path of manifests) {
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (manifest.version !== requested) {
      mismatches.push(`${path}: ${manifest.version}`);
    }
  }
  const versionSource = await readFile("packages/cli/src/version.ts", "utf8");
  const createSource = await readFile(
    "packages/create-papucs/src/index.ts",
    "utf8",
  );
  if (!versionSource.includes(`"${requested}"`)) {
    mismatches.push("packages/cli/src/version.ts");
  }
  if (!createSource.includes(`"${requested}"`)) {
    mismatches.push("packages/create-papucs/src/index.ts");
  }

  if (mismatches.length > 0) {
    console.error(
      `Release version ${requested} does not match:\n${mismatches.join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`Release version ${requested} is consistent.`);
  }
}
