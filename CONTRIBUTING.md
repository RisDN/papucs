# Contributing

Requirements: Node.js 22+ and npm.

```bash
npm ci
npm run verify
npm run audit:content
npm run audit:licenses
npm run pack:check
```

Keep changes focused. Add isolated fixtures instead of depending on a real
Minecraft network repository. Never commit JARs, world data, secrets, `.env`, or
generated `.runtime` content.

Public behavior changes require tests and documentation. JSON contracts and
configuration schema changes follow semantic versioning.

The opt-in lifecycle regression requires a running Docker daemon, Compose and
the `node:22-alpine` image already available locally:

```bash
docker pull node:22-alpine
npm run build
npm run test:docker:lifecycle
```

It creates a unique temporary project, verifies read-only diagnostics and
planning, then exercises existing-container startup, an intentional SIGKILL and
recovery. Only that fixture's containers, volume and temporary directory are
removed.
