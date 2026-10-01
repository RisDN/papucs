import { describe, expect, test } from "vitest";
import {
  buildDependencyGraph,
  dependencyLayers,
  dependentClosure,
  mergeDeclaredDependencies,
} from "./dependencies";
import type { RuntimeComposeService, RuntimeInstance } from "./types";

function instance(
  id: string,
  serverType: string,
  serviceName = id,
): RuntimeInstance {
  return { id, serverType, serviceName } as RuntimeInstance;
}

describe("dependency graph", () => {
  test("orders providers first and consumers first on shutdown, with parallel layers", () => {
    const graph = buildDependencyGraph({
      workerB: { depends_on: ["gateway", "database"] },
      cache: {},
      workerA: { depends_on: { gateway: { condition: "service_healthy" } } },
      database: {},
      gateway: { depends_on: ["cache", "database"] },
    });
    expect(dependencyLayers(graph)).toEqual([
      ["cache", "database"],
      ["gateway"],
      ["workerA", "workerB"],
    ]);
    expect(dependencyLayers(graph, undefined, "reverse")).toEqual([
      ["workerA", "workerB"],
      ["gateway"],
      ["cache", "database"],
    ]);
    expect(dependencyLayers(graph, ["gateway", "workerA"])).toEqual([
      ["gateway"],
      ["workerA"],
    ]);
    expect([...dependentClosure(graph, ["cache"])]).toEqual([
      "cache",
      "gateway",
      "workerB",
      "workerA",
    ]);
  });

  test.each([
    [{ consumer: { depends_on: ["absent"] } }, "missing service 'absent'"],
    [{ self: { depends_on: ["self"] } }, "cannot depend on itself"],
    [
      { a: { depends_on: ["b"] }, b: { depends_on: ["a"] } },
      "Dependency cycle",
    ],
  ])("rejects invalid topology %j", (services, message) => {
    expect(() => buildDependencyGraph(services)).toThrow(message);
  });

  test("honors optional missing raw dependencies and preserves their definitions", () => {
    const services = {
      consumer: {
        depends_on: {
          missing: { required: false, condition: "service_started" },
          database: { condition: "service_healthy", restart: true },
        },
      },
      database: {},
    };
    const original = JSON.stringify(services);
    expect([...buildDependencyGraph(services).get("consumer")!]).toEqual([
      "database",
    ]);
    expect(JSON.stringify(services)).toBe(original);
  });

  test("includes implicit Compose service dependencies but ignores external containers", () => {
    const graph = buildDependencyGraph({
      database: {},
      network: {},
      consumer: {
        links: ["database:db"],
        volumes_from: ["database:ro", "container:external:ro"],
        network_mode: "service:network",
        ipc: "service:database",
        pid: "service:network",
      },
    });
    expect([...graph.get("consumer")!]).toEqual(["database", "network"]);
  });

  test("rejects unknown selections and invalid raw dependency definitions", () => {
    const graph = buildDependencyGraph({ present: {} });
    expect(() => dependencyLayers(graph, ["absent"])).toThrow(
      "Unknown dependency graph service",
    );
    expect(() => dependentClosure(graph, ["absent"])).toThrow(
      "Unknown dependency graph service",
    );
    expect(() =>
      buildDependencyGraph({ invalid: { depends_on: [1] } }),
    ).toThrow("Invalid depends_on");
    expect(() =>
      buildDependencyGraph({
        invalid: { depends_on: { present: { condition: "ready" } } },
        present: {},
      }),
    ).toThrow("Invalid dependency condition");
  });
});

describe("manifest dependency resolution", () => {
  test("resolves generic services, unique server types and exact instance IDs", () => {
    const service: RuntimeComposeService = {
      depends_on: { database: { condition: "service_healthy", restart: true } },
    };
    mergeDeclaredDependencies({
      serviceName: "worker-7",
      service,
      declarations: [
        { service: "database", condition: "service_healthy" },
        { server: "gateway", condition: "service_healthy" },
        { instance: "helper-9", condition: "service_completed_successfully" },
      ],
      instances: [
        instance("gateway-4", "gateway", "gateway-service"),
        instance("helper-9", "helper"),
      ],
      infrastructureServices: new Set(["database"]),
    });
    expect(service.depends_on).toEqual({
      database: { condition: "service_healthy", restart: true },
      "gateway-service": { condition: "service_healthy" },
      "helper-9": { condition: "service_completed_successfully" },
    });
  });

  test("merges short raw dependencies while keeping their startup behavior", () => {
    const service: RuntimeComposeService = { depends_on: ["database"] };
    mergeDeclaredDependencies({
      serviceName: "worker-1",
      service,
      declarations: [{ service: "database" }, { server: "gateway" }],
      instances: [instance("gateway-1", "gateway")],
      infrastructureServices: new Set(["database"]),
    });
    expect(service.depends_on).toEqual({
      database: { condition: "service_started" },
      "gateway-1": { condition: "service_started" },
    });
  });

  test.each([
    [{ service: "missing" }, [], "does not exist"],
    [{ server: "gateway" }, [], "has no managed or planned instance"],
    [
      { instance: "gateway-1" },
      [instance("gateway-2", "gateway")],
      "has no managed or planned instance",
    ],
    [
      { server: "gateway" },
      [instance("gateway-1", "gateway"), instance("gateway-2", "gateway")],
      "is ambiguous",
    ],
    [
      { instance: "worker-1" },
      [instance("worker-1", "worker")],
      "cannot depend on itself",
    ],
  ])(
    "rejects unresolved or unsafe manifest target %j",
    (declaration, instances, message) => {
      expect(() =>
        mergeDeclaredDependencies({
          serviceName: "worker-1",
          service: {},
          declarations: [declaration],
          instances,
          infrastructureServices: new Set(),
        }),
      ).toThrow(message);
    },
  );

  test.each([
    { condition: "service_started" },
    { condition: "service_healthy", required: false },
  ])("rejects conflicting raw dependency %j", (definition) => {
    expect(() =>
      mergeDeclaredDependencies({
        serviceName: "worker-1",
        service: { depends_on: { database: definition } },
        declarations: [{ service: "database", condition: "service_healthy" }],
        instances: [],
        infrastructureServices: new Set(["database"]),
      }),
    ).toThrow("Conflicting dependency");
  });
});
