import { existsSync } from "node:fs";
import { buildRuntimeCompose } from "./compose";
import { readYamlObject } from "./config";
import { buildDependencyGraph, dependencyLayers } from "./dependencies";
import type { ComposeDocument, ProjectContext, RuntimeState } from "./types";

/** Preserve both saved and current dependency edges until shutdown is proven. */
export async function buildShutdownCompose(
  context: ProjectContext,
  state: RuntimeState,
): Promise<ComposeDocument> {
  const planned = await buildRuntimeCompose(context, state);
  const graph = buildDependencyGraph(planned.services ?? {});
  if (existsSync(context.runtimeComposePath)) {
    const actual = await readYamlObject<ComposeDocument>(
      context.runtimeComposePath,
    );
    const previous = buildDependencyGraph(actual.services ?? {});
    for (const [service, providers] of previous) {
      if (!graph.has(service)) graph.set(service, new Set());
      for (const provider of providers) graph.get(service)?.add(provider);
    }
  }
  dependencyLayers(graph); // A reversed dependency edit can introduce a cycle in the conservative union.
  return {
    ...planned,
    services: Object.fromEntries(
      [...graph].map(([service, providers]) => [
        service,
        { ...planned.services?.[service], depends_on: [...providers] },
      ]),
    ),
  };
}
