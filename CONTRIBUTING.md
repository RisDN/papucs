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
