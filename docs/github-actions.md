# GitHub Actions and GHCR

Configure the project image repository:

```yaml
build:
  image: "ghcr.io/%github_owner%/mc-%server_type%"
  tags: ["%ref%", "%sha%"]
```

Generate workflow:

```bash
npx papucs workflow add ghcr-build
```

The workflow:

1. installs the locked npm dependency graph,
2. logs into GHCR using `GITHUB_TOKEN`,
3. runs `npx papucs build --actions --push --json`.

It does not parse human console output and does not deploy images.

Required repository permission:

```yaml
permissions:
  contents: read
  packages: write
```

Use the resulting image with the runtime platform of your choice.
