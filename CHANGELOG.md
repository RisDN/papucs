# Changelog

All notable changes follow semantic versioning.

## 0.1.1

- Restore clean runtime replacement for `up`, `rebuild`, and `restart`.
- Preserve configured runtime-owned paths during clean replacement.

## 0.1.0

- Node.js 22+ local-development CLI.
- Explicit `papucs.yml` project contract.
- Layer/server materialization, sync, lifecycle, and safe project-scoped stop.
- OCI image build, JSON output, push, and GHCR workflow generation.
- `create-papucs` initializer with a clean Minecraft template.
- Windows, macOS, and Linux package/test matrix.
