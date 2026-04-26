# Release Management

## Goal

Phase 13 now includes a release control slice that tracks:

- versioned release manifests
- published registry image coordinates
- deployment target metadata for staging
- promotion and rollback history across multiple releases
- compose-backed staging validation before promotion

The release metadata lives in-repo so operators can inspect exactly which image set,
manifest, and environment target was promoted at any point in time.

## Release files

- release manifests live under [`infra/releases/manifests/`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/infra/releases/manifests)
- environment state lives under [`infra/releases/environments/`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/infra/releases/environments)
- the staging environment pointer is [`staging.json`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/infra/releases/environments/staging.json)

Each manifest now records:

- release version, git SHA, git ref, and generator
- required validation checks and operator probe commands
- runtime dependencies and compose inputs
- deployment target metadata for `infra/kubernetes`
- publishable image inventory for every deployable service
- registry host, namespace, image tags, and publication status

The environment state now records:

- the active and previous release version
- the active image set for the environment
- ordered promotion and rollback history
- historical release records with image metadata
- rollback candidates beyond a single `previousReleaseVersion`

## Local commands

```bash
pnpm release:status -- --environment staging
pnpm release:verify:staging
pnpm release:bundle -- --environment staging --release-version staging-20260416-abcdef0
pnpm release:publish:staging -- --release-version staging-20260416-abcdef0
pnpm runtime:staging:up
pnpm canary:staging
pnpm smoke:staging -- --probe-only
pnpm release:deploy:staging -- --release-version staging-20260416-abcdef0 --actor local-operator --reason "Promote validated staging build"
pnpm release:rollback:staging -- --actor local-operator --reason "Restore previously published image set"
pnpm runtime:staging:down
```

Useful flags:

- `--dry-run`
- `--release-version <version>`
- `--target-release-version <version>` for explicit rollback targets
- `--registry-host <host>` to override the default registry
- `--image-namespace <namespace>` to override the default repository namespace
- `--actor <name>`
- `--reason <summary>`

## Deploy workflow

Use the GitHub Actions workflow [`release-staging.yml`](/c:/Users/simor/Documents/Mod_Compatibilities_Project/.github/workflows/release-staging.yml).

For the `deploy` action it now:

- validates contracts, typecheck, regression fixtures, and the web build
- builds and boots the compose-backed staging runtime
- tags and pushes deployable service images to GHCR under `ghcr.io/<owner>/platform/<service>:<release-version>`
- records the published image set in the release manifest
- runs canary and staging probe validation against the deployed services
- promotes the release into the staging environment state
- verifies the resulting manifest and environment references
- uploads `infra/releases/` as a workflow artifact
- commits the updated release metadata back to the branch

## Rollback workflow

For the `rollback` action it:

- resolves the rollback target from `--target-release-version`, the rollback candidate list, or `previousReleaseVersion`
- restores the environment pointer to that release
- restores the corresponding published image set in release metadata
- preserves the full rollback event in environment history
- uploads the updated release metadata and commits the change

Historical rollback is no longer limited to a single previous pointer. Operators can
target any earlier release manifest that still exists in `infra/releases/manifests/`.

## Release manifest contents

Each release manifest captures:

- release version and git source metadata
- validation commands expected before promotion
- service inventory, health endpoints, startup commands, and required env keys
- infrastructure dependency inventory
- deployment target details such as namespace and manifest path
- image artifact inventory including local image refs, remote image refs, and publish status

## Operational notes

- The compose-backed staging deployment is still the runtime validation path used in CI.
- Kubernetes manifests are tracked as the persistent deployment target reference in release metadata.
- Registry publication assumes the workflow has permission to push to GHCR through the default `GITHUB_TOKEN`.
- The release manifest stores image references and publication timestamps. Digest capture can be layered in later if the registry policy requires immutable digest pinning in the control plane.
