import { describe, expect, test } from "vitest";
import { sanitizeDockerTagValue } from "./build";

describe("sanitizeDockerTagValue", () => {
  test("converts Git refs into valid Docker tag values", () => {
    expect(sanitizeDockerTagValue("agent/papucs-v0.1")).toBe(
      "agent-papucs-v0.1",
    );
    expect(sanitizeDockerTagValue(" feature/ref with spaces ")).toBe(
      "feature-ref-with-spaces",
    );
    expect(sanitizeDockerTagValue("../")).toBe("unknown");
  });

  test("limits tag values to the Docker maximum", () => {
    expect(sanitizeDockerTagValue("a".repeat(200))).toHaveLength(128);
  });
});
