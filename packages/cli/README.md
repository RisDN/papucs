# papucs

Local-first Minecraft server development and OCI image build CLI.

```bash
npm install --save-dev papucs
npx papucs doctor
npx papucs dev spawn
```

Keep a Compose service running during `papucs restartall`:

```yaml
services:
  database:
    image: mongo:8
    x-papucs.restartall: false
```

The nested form `x-papucs: { restartall: false }` is also supported in root,
shared, and server-specific Compose templates. Omitted flags default to `true`.
Other lifecycle commands are unaffected. A restart is refused before stopping
services if an excluded running consumer depends on a selected provider.

Recover an existing stopped instance without rebuilding its runtime files:

```bash
npx papucs start spawn-1
npx papucs stopall --dry-run
npx papucs diagnose spawn-1 --json
```

`start` includes existing dependencies and fails before mutation if required
containers or managed runtime data are missing. The shutdown preview compares
source, generated Compose and Docker lifecycle settings. Diagnostics include
bounded, redacted logs and available Docker event evidence; review before
sharing.

Select a custom image startup script in a server definition:

```yaml
build:
  runtime_script: scripts/spawn-runtime.sh
```

The path is relative to the project root and must name an existing file inside
it. Omit the field to keep `scripts/papucs-runtime-replace.sh`. The selected
file is packaged as `papucs-runtime-replace.sh` in the image build context; use
`COPY %runtime_script% /runtime.sh` in the Dockerfile template and configure its
entrypoint. Local Compose startup and data-preservation behavior are unchanged
by this setting.

See the [full documentation](https://github.com/RisDN/papucs#readme).

Requires Node.js 22+ and Docker Compose. MIT licensed.
