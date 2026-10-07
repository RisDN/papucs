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

See the [full documentation](https://github.com/RisDN/papucs#readme).

Requires Node.js 22+ and Docker Compose. MIT licensed.
