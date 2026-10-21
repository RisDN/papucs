import { describe, expect, test } from "vitest";
import { runCommand } from "./process";

describe("bounded command capture", () => {
  test("preserves successful process output", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write('ok');process.stderr.write('warning')"],
      { cwd: process.cwd(), timeoutMs: 5000, maxOutputBytes: 100 },
    );
    expect(result).toEqual({ code: 0, stdout: "ok", stderr: "warning" });
  });
  test("terminates an unresponsive read", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { cwd: process.cwd(), timeoutMs: 250 },
    );
    expect(result.code).toBe(-1);
    expect(result.stderr).toBe("Command timed out.");
  });
  test("bounds output while reading, not only after exit", async () => {
    const result = await runCommand(
      process.execPath,
      [
        "-e",
        "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)",
      ],
      { cwd: process.cwd(), timeoutMs: 5000, maxOutputBytes: 64 },
    );
    expect(result.code).toBe(-1);
    expect(result.stdout).toHaveLength(64);
    expect(result.stderr).toBe("Command output exceeded the capture limit.");
  });
});
