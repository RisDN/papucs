import { existsSync } from "node:fs";
import {
  buildRuntimeCompose,
  buildRuntimeServiceDefinition,
  loadServerComposeTemplate,
} from "../compose";
import { readYamlObject } from "../config";
import { buildDependencyGraph, dependencyLayers } from "../dependencies";
import { buildRuntimeTemplateContext, loadMergedEnv } from "../env";
import { resolveGitMetadata } from "../git";
import { inspectProjectContainers } from "../inspection";
import type { ContainerSnapshot } from "../inspection";
import { loadServerConfig } from "../manifest";
import { buildShutdownCompose } from "../shutdown";
import { emptyState, loadStateReadOnly } from "../state";
import type {
  ComposeDocument,
  ProjectContext,
  RuntimeComposeService,
  RuntimeState,
} from "../types";

type UnknownValue = "unknown";

export interface StopLifecycleSettings {
  /** Null means no configured timeout; the daemon default is unknown. */
  stopTimeoutSeconds: number | null | UnknownValue;
  /** Null means inherited from the image or daemon. */
  stopSignal: string | null | UnknownValue;
  init: boolean | null | UnknownValue;
  restartPolicy: string | null;
  healthcheckEnabled: boolean | null | UnknownValue;
  /** Docker inspection does not establish dependency edges. */
  dependencies: string[] | null;
}

export interface StopPlanIssue {
  code: string;
  message: string;
  service?: string;
}

export interface StopPlanLifecycleDiff {
  service: string;
  source: StopLifecycleSettings | null;
  generated: StopLifecycleSettings | null;
  actual: Array<{
    id: string;
    settings: StopLifecycleSettings;
    differsFromGenerated: Array<keyof StopLifecycleSettings>;
  }>;
  sourceDiffersFromGenerated: Array<keyof StopLifecycleSettings>;
}

export interface StopPlanReport {
  ok: boolean;
  project: string;
  composeProjectName: string;
  runtimeComposePresent: boolean;
  runningServices: string[];
  stopLayers: string[][];
  acceptedExitCodes: number[];
  requiresOomFalse: boolean;
  blockers: StopPlanIssue[];
  warnings: StopPlanIssue[];
  lifecycleDiffs: StopPlanLifecycleDiff[];
  cleanup: {
    removeProjectContainers: boolean;
    containers: Array<
      Pick<ContainerSnapshot, "id" | "service" | "name" | "status">
    >;
    managedInstanceIds: string[] | null;
    clearInstanceList: boolean;
    clearSyncCache: boolean;
    preserveNamedVolumes: boolean;
    preserveInstanceData: boolean;
  };
}

function durationSeconds(value: unknown): number | null | UnknownValue {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "unknown";
  const input = value.trim();
  if (input === "0") return 0;
  const units: Record<string, number> = {
    h: 3600,
    m: 60,
    s: 1,
    ms: 0.001,
    us: 0.000001,
    µs: 0.000001,
    μs: 0.000001,
    ns: 0.000000001,
  };
  const parts = [...input.matchAll(/(\d+(?:\.\d+)?)(ms|us|µs|μs|ns|h|m|s)/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== input) {
    return "unknown";
  }
  const seconds = parts.reduce(
    (sum, part) => sum + Number(part[1]) * units[part[2]!]!,
    0,
  );
  return Number.isFinite(seconds) ? seconds : "unknown";
}

function stopSignal(value: unknown): string | null | UnknownValue {
  if (value === undefined || value === null || value === "") return null;
  const signals = new Set([
    "HUP",
    "INT",
    "QUIT",
    "ILL",
    "TRAP",
    "ABRT",
    "IOT",
    "BUS",
    "FPE",
    "KILL",
    "USR1",
    "SEGV",
    "USR2",
    "PIPE",
    "ALRM",
    "TERM",
    "STKFLT",
    "CHLD",
    "CLD",
    "CONT",
    "STOP",
    "TSTP",
    "TTIN",
    "TTOU",
    "URG",
    "XCPU",
    "XFSZ",
    "VTALRM",
    "PROF",
    "WINCH",
    "IO",
    "POLL",
    "PWR",
    "SYS",
  ]);
  const text = String(value).toUpperCase();
  if (/^\d+$/.test(text) && Number(text) > 0 && Number(text) <= 64) return text;
  const name = text.replace(/^SIG/, "");
  return signals.has(name) ? `SIG${name}` : "unknown";
}

function restartPolicy(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "no";
  return typeof value === "string" &&
    /^(no|always|unless-stopped|on-failure(?::\d+)?)$/.test(value)
    ? value
    : null;
}

function configuredSettings(
  service: RuntimeComposeService,
  dependencies: Set<string> | null,
): StopLifecycleSettings {
  const healthcheck = service.healthcheck;
  let healthcheckEnabled: StopLifecycleSettings["healthcheckEnabled"] = null;
  if (
    healthcheck &&
    typeof healthcheck === "object" &&
    !Array.isArray(healthcheck)
  ) {
    const check = healthcheck as Record<string, unknown>;
    if (
      check.disable === true ||
      (Array.isArray(check.test) && check.test[0] === "NONE")
    ) {
      healthcheckEnabled = false;
    } else if (
      typeof check.test === "string" ||
      (Array.isArray(check.test) && check.test.length > 0)
    ) {
      healthcheckEnabled = true;
    }
  } else if (healthcheck !== undefined && healthcheck !== null) {
    healthcheckEnabled = "unknown";
  }
  return {
    stopTimeoutSeconds: durationSeconds(service.stop_grace_period),
    stopSignal: stopSignal(service.stop_signal),
    init:
      service.init === undefined || service.init === null
        ? null
        : typeof service.init === "boolean"
          ? service.init
          : "unknown",
    restartPolicy: restartPolicy(service.restart),
    healthcheckEnabled,
    dependencies: dependencies === null ? null : [...dependencies].sort(),
  };
}

function actualSettings(container: ContainerSnapshot): StopLifecycleSettings {
  return {
    stopTimeoutSeconds: container.stopTimeout,
    stopSignal: stopSignal(container.stopSignal),
    init: container.init,
    restartPolicy: restartPolicy(container.restartPolicy),
    healthcheckEnabled: container.healthcheckEnabled,
    dependencies: null,
  };
}

const settingFields: Array<keyof StopLifecycleSettings> = [
  "stopTimeoutSeconds",
  "stopSignal",
  "init",
  "restartPolicy",
  "healthcheckEnabled",
  "dependencies",
];

function changedSettings(
  before: StopLifecycleSettings | null,
  after: StopLifecycleSettings | null,
  actual = false,
): Array<keyof StopLifecycleSettings> {
  if (!before || !after) {
    return before === after
      ? []
      : settingFields.filter((field) => !actual || field !== "dependencies");
  }
  return settingFields.filter((field) => {
    // Omission in Compose leaves Docker/image defaults unconstrained. In the
    // other direction, an explicit setting missing from Docker is known drift,
    // even though the effective inherited/default value remains unknown.
    if (
      actual &&
      (field === "dependencies" ||
        before[field] === null ||
        before[field] === "unknown" ||
        after[field] === "unknown")
    )
      return false;
    return JSON.stringify(before[field]) !== JSON.stringify(after[field]);
  });
}

/** Rebuild current templates in a private state copy; never materialize or persist. */
async function currentSourceCompose(
  context: ProjectContext,
  state: RuntimeState,
): Promise<ComposeDocument> {
  const projected: RuntimeState = { version: state.version, instances: [] };
  const git =
    state.instances.length > 0 ? await resolveGitMetadata(context) : null;
  for (const instance of state.instances) {
    const config = await loadServerConfig(context, instance.serverType);
    const template = await loadServerComposeTemplate(
      context,
      instance.serverType,
      config,
    );
    const mergedEnv = await loadMergedEnv(context, instance.serverType, config);
    const variables = buildRuntimeTemplateContext({
      serverType: instance.serverType,
      instanceId: instance.id,
      index: instance.index,
      instanceName: instance.serverName,
      portBase: config.papucs_port_base,
      mergedEnv: { ...mergedEnv, REF_TAG: git!.ref, SHA_TAG: git!.sha },
    });
    projected.instances.push({
      ...instance,
      composeService: buildRuntimeServiceDefinition({
        templateService: template.appServiceDefinition,
        image: config.image,
        serverName: instance.serverName,
        variables,
      }),
    });
  }
  return await buildRuntimeCompose(context, projected);
}

function graphIssue(error: unknown): StopPlanIssue {
  // Never forward parser snippets, Docker stderr, paths or interpolated values.
  const cycle =
    error instanceof Error &&
    error.message.startsWith("Dependency cycle detected");
  return {
    code: cycle ? "dependency-cycle" : "invalid-shutdown-graph",
    message: cycle
      ? "Shutdown dependencies contain a cycle."
      : "Shutdown dependencies could not be resolved from the current project and generated Compose.",
  };
}

function comparisonGraph(document: ComposeDocument | null) {
  if (!document) return null;
  try {
    return buildDependencyGraph(document.services ?? {});
  } catch {
    // The shutdown planner reports graph blockers; invalid edges are not guessed.
    return null;
  }
}

export async function commandStopPlan(
  context: ProjectContext,
): Promise<StopPlanReport> {
  const report: StopPlanReport = {
    ok: false,
    project: context.config.project,
    composeProjectName: context.composeProjectName,
    runtimeComposePresent: existsSync(context.runtimeComposePath),
    runningServices: [],
    stopLayers: [],
    acceptedExitCodes: [0, 143],
    requiresOomFalse: true,
    blockers: [],
    warnings: [],
    lifecycleDiffs: [],
    cleanup: {
      removeProjectContainers: existsSync(context.runtimeComposePath),
      containers: [],
      managedInstanceIds: null,
      clearInstanceList: true,
      clearSyncCache: true,
      preserveNamedVolumes: true,
      preserveInstanceData: true,
    },
  };
  let state = emptyState();
  let stateAvailable = true;
  try {
    state = await loadStateReadOnly(context);
    report.cleanup.managedInstanceIds = state.instances
      .map((instance) => instance.id)
      .sort();
  } catch {
    stateAvailable = false;
    report.blockers.push({
      code: "unreadable-state",
      message: "Runtime state could not be read or parsed.",
    });
  }
  let containers: ContainerSnapshot[] = [];
  try {
    containers = await inspectProjectContainers(context);
    report.cleanup.containers = containers.map(
      ({ id, service, name, status }) => ({ id, service, name, status }),
    );
  } catch {
    report.blockers.push({
      code: "inspection-failed",
      message:
        "Project containers could not be inspected; stop cannot be verified.",
    });
  }
  report.runningServices = [
    ...new Set(
      containers
        .filter((container) => container.running || container.restarting)
        .map((container) => container.service),
    ),
  ].sort();
  for (const container of containers) {
    if (container.running || container.restarting) continue;
    if (
      !["exited", "created"].includes(container.status) ||
      container.oomKilled ||
      ![0, 143].includes(container.exitCode)
    ) {
      report.blockers.push({
        code: "unproven-previous-stop",
        service: container.service,
        message: `Service '${container.service}' has an unproven previous stop (status=${container.status}, exit=${container.exitCode}, OOM=${container.oomKilled}).`,
      });
    }
  }
  if (
    !report.runtimeComposePresent &&
    (report.runningServices.length > 0 || state.instances.length > 0)
  ) {
    report.blockers.push({
      code: "missing-runtime-compose",
      message: "Runtime Compose is missing; stop cannot be verified.",
    });
  }
  let generated: ComposeDocument | null = null;
  if (report.runtimeComposePresent) {
    try {
      generated = await readYamlObject<ComposeDocument>(
        context.runtimeComposePath,
      );
    } catch {
      report.blockers.push({
        code: "unreadable-runtime-compose",
        message: "Generated Compose could not be read or parsed.",
      });
    }
  }
  let source: ComposeDocument | null = null;
  if (stateAvailable) {
    try {
      source = await currentSourceCompose(context, state);
    } catch {
      report.warnings.push({
        code: "source-unavailable",
        message:
          "Current source lifecycle settings could not be resolved; source comparison is unavailable.",
      });
    }
    try {
      const shutdown = await buildShutdownCompose(context, state);
      const graph = buildDependencyGraph(shutdown.services ?? {});
      const unknown = report.runningServices.filter(
        (service) => !graph.has(service),
      );
      for (const service of unknown)
        report.blockers.push({
          code: "unknown-running-service",
          service,
          message: `Running service '${service}' is absent from the shutdown graph.`,
        });
      if (unknown.length === 0)
        report.stopLayers = dependencyLayers(
          graph,
          report.runningServices,
          "reverse",
        );
    } catch (error) {
      report.blockers.push(graphIssue(error));
    }
  }
  const serviceNames = new Set([
    ...Object.keys(source?.services ?? {}),
    ...Object.keys(generated?.services ?? {}),
    ...containers.map((container) => container.service),
  ]);
  const sourceGraph = comparisonGraph(source);
  const generatedGraph = comparisonGraph(generated);
  report.lifecycleDiffs = [...serviceNames].sort().map((service) => {
    const sourceDefinition = source?.services?.[service];
    const generatedDefinition = generated?.services?.[service];
    const sourceSettings = sourceDefinition
      ? configuredSettings(sourceDefinition, sourceGraph?.get(service) ?? null)
      : null;
    const generatedSettings = generatedDefinition
      ? configuredSettings(
          generatedDefinition,
          generatedGraph?.get(service) ?? null,
        )
      : null;
    return {
      service,
      source: sourceSettings,
      generated: generatedSettings,
      sourceDiffersFromGenerated:
        source === null || generated === null
          ? []
          : changedSettings(sourceSettings, generatedSettings),
      actual: containers
        .filter((container) => container.service === service)
        .map((container) => {
          const settings = actualSettings(container);
          return {
            id: container.id,
            settings,
            differsFromGenerated:
              generated === null
                ? []
                : changedSettings(generatedSettings, settings, true),
          };
        }),
    };
  });
  report.ok = report.blockers.length === 0;
  return report;
}

function displaySetting(
  field: keyof StopLifecycleSettings,
  value: StopLifecycleSettings[keyof StopLifecycleSettings],
): string {
  if (value === null)
    return field === "stopTimeoutSeconds"
      ? "unknown daemon default"
      : "inherited / unavailable";
  return Array.isArray(value) ? value.join(", ") || "none" : String(value);
}

export function formatStopPlan(report: StopPlanReport): string[] {
  const lines = [
    `Stop plan for '${report.project}': ${report.ok ? "ready" : "blocked"} (read-only snapshot).`,
    "Accepted stop exits: 0, 143; OOM must be false. State is rechecked during execution.",
  ];
  for (const issue of report.blockers) lines.push(`BLOCKER: ${issue.message}`);
  for (const issue of report.warnings) lines.push(`WARNING: ${issue.message}`);
  if (report.stopLayers.length === 0) lines.push("No stop layers planned.");
  report.stopLayers.forEach((layer, index) =>
    lines.push(`Stop layer ${index + 1}: ${layer.join(", ")}`),
  );
  lines.push(
    report.cleanup.removeProjectContainers
      ? `Cleanup after successful stops: docker compose down --remove-orphans in this project (${report.cleanup.containers.length} inspected service container(s)); clear instance list and sync cache.`
      : "Runtime Compose is absent: no Docker cleanup; clear instance list and sync cache only if no blockers remain.",
  );
  lines.push("Named volumes and instance data directories are retained.");
  for (const diff of report.lifecycleDiffs) {
    const fields = new Set([
      ...diff.sourceDiffersFromGenerated,
      ...diff.actual.flatMap((actual) => actual.differsFromGenerated),
    ]);
    // Show timeout defaults even when there is no provable configuration drift.
    fields.add("stopTimeoutSeconds");
    for (const field of fields) {
      const source = diff.source
        ? displaySetting(field, diff.source[field])
        : "unavailable";
      const generated = diff.generated
        ? displaySetting(field, diff.generated[field])
        : "unavailable";
      const actual =
        diff.actual
          .map(
            (entry) =>
              `${entry.id.slice(0, 12)}=${displaySetting(field, entry.settings[field])}`,
          )
          .join(", ") || "no container";
      lines.push(
        `${diff.service} ${field}: source=${source}; generated=${generated}; actual=${actual}`,
      );
    }
  }
  return lines;
}
