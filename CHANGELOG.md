# Changelog

All notable changes follow semantic versioning.

## 0.3.0

- Allow layers to include other layers through `_layer.yml` with recursive,
  ordered overrides, subtree build exclusions, and cycle validation.

## 0.2.0

- Add configurable server `depends_on` declarations targeting infrastructure
  services, server types, or exact managed instances, with Compose readiness
  conditions.
- Plan complete `up` batches before resolving dependencies or writing runtime
  data; reject missing, ambiguous, conflicting, and cyclic dependencies.
- Stop consumers before providers and verify each dependency layer has exited.
  Retain runtime state and running providers after a failed or unproven stop.
- Restart running workloads in two phases: stop all consumers before providers,
  then start providers before consumers. Previously stopped workloads stay
  stopped.
- Refuse targeted provider removal, restart, or rebuild while dependents run.
- Prevent implicit provider recreation during targeted startup and exclude
  Compose one-off containers from managed service inventory.
- Document dependency configuration, shutdown checks, and lifecycle migration.
- Update compatible development dependency patches to resolve high-severity
  audit findings.

## 0.1.2

- Add `papucs attach <instance>` for attaching to managed Docker containers by
  instance name.
- Refresh development dependencies to patched versions.

## 0.1.1

- Restore clean runtime replacement for `up`, `rebuild`, and `restart`.
- Preserve configured runtime-owned paths during clean replacement.
- Preserve the Minecraft container cache in newly initialized projects.
- Map Minecraft container writes to the host user on Linux.

## 0.1.0

- Node.js 22+ local-development CLI.
- Explicit `papucs.yml` project contract.
- Layer/server materialization, sync, lifecycle, and safe project-scoped stop.
- OCI image build, JSON output, push, and GHCR workflow generation.
- `create-papucs` initializer with a clean Minecraft template.
- Windows, macOS, and Linux package/test matrix.
