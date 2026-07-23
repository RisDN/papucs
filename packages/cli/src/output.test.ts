import { describe, expect, test } from "vitest";
import { jsonEnvelope } from "./output";

describe("JSON contract", () => {
  test("uses the versioned stable envelope", () => {
    expect(jsonEnvelope("status", { instances: [] })).toEqual({
      schemaVersion: 1,
      ok: true,
      command: "status",
      data: { instances: [] },
      warnings: [],
    });
  });
});
