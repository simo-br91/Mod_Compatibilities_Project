# Onyxia Runbook

This runbook is for running the mod compatibility pipelines on SSP Cloud / Onyxia with a Linux
service.

Use it when you want:
- longer unattended runs than a laptop is comfortable with
- more CPU and RAM for offline synthesis
- moderate parallelism for Forge ground-truth runs

Use a Linux service for this workflow. The ground-truth runner now auto-detects the launcher and
uses `run.sh` on Linux and `run.bat` on Windows.

## 1. What To Run In The Cloud

Good cloud candidates:
- catalog generation
- offline pipeline
- ground-truth execution with low-to-moderate concurrency

Keep these expectations realistic:
- the offline pipeline usually benefits the most from extra CPU
- ground-truth throughput mainly improves when you raise concurrency
- start with `GROUND_TRUTH_CONCURRENCY=2`, then increase only after a stable run

## 2. Launch A Service In Onyxia

Pick an interactive Linux service with a terminal, such as VS Code or a generic Ubuntu-like
workspace.

Recommended starting resources:
- offline pipeline only: 4 vCPU, 16 GB RAM
- offline + ground truth: 8 vCPU, 32 GB RAM
- disk / persistence: enable it if the catalog offers a persistence toggle

If the launcher shows a Security tab:
- set a password you control
- leave IP protection enabled unless you explicitly need to share the service

Useful official references:
- Onyxia user guide: https://docs.onyxia.sh/docs.onyxia.sh/v7/user-guide
- SSP Cloud service configuration: https://docs.sspcloud.fr/en/content/services-configuration.html
- SSP Cloud storage: https://docs.sspcloud.fr/en/content/storage.html

## 3. Open A Terminal And Install Prerequisites

Run these commands in the service terminal.

Install system packages:

```bash
apt-get update
apt-get install -y curl git openjdk-17-jre-headless
```

Install Node 22 with `nvm`:

```bash
export NVM_DIR="$HOME/.nvm"
mkdir -p "$NVM_DIR"
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
. "$NVM_DIR/nvm.sh"
nvm install 22
nvm alias default 22
```

Enable `pnpm` through Corepack:

```bash
corepack enable
corepack prepare pnpm@10.0.0 --activate
```

Verify the toolchain:

```bash
node -v
pnpm -v
java -version
git --version
```

## 4. Get The Repository

Clone your repository:

```bash
git clone <YOUR_GIT_URL> modcompat
cd modcompat
```

Install dependencies:

```bash
pnpm install
```

Optional quick sanity check:

```bash
pnpm typecheck
```

## 5. Configure `.env`

Create or edit `.env` in the repo root.

Minimum cloud-ready settings:

```dotenv
POSTGRES_URL=...
GROUND_TRUTH_FORGE_TEMPLATE_DIR=/home/onyxia/modcompat/runtime/forge-1.20.1-server-template
GROUND_TRUTH_FORGE_VERSION=47.4.20
GROUND_TRUTH_FORGE_VERSION_BY_MINECRAFT=1.20.1=47.4.20
GROUND_TRUTH_FORGE_LAUNCH_COMMAND=
GROUND_TRUTH_CONCURRENCY=2
GROUND_TRUTH_WORKDIR_ROOT=/home/onyxia/modcompat/.ground-truth-workdir
GROUND_TRUTH_MOD_CACHE_DIR=/home/onyxia/modcompat/.ground-truth-cache/mods
GROUND_TRUTH_TIMEOUT_MS=900000
GROUND_TRUTH_FORGE_READY_GRACE_MS=8000
```

Notes:
- keep `GROUND_TRUTH_FORGE_LAUNCH_COMMAND` blank to let the runner auto-detect Linux
- `GROUND_TRUTH_CONCURRENCY=2` is the safest first cloud setting
- if your home directory is different, replace `/home/onyxia/...` with the actual path

## 6. Prepare The Forge Template

The repository already contains the Forge 1.20.1 template. On Linux, just make sure the launch
script is executable:

```bash
chmod +x runtime/forge-1.20.1-server-template/run.sh
```

If you want to inspect the template:

```bash
ls runtime/forge-1.20.1-server-template
```

You should see at least:
- `run.sh`
- `run.bat`
- `libraries/`
- `user_jvm_args.txt`

## 7. Run The Pipelines

Generate a catalog:

```bash
pnpm exec tsx scripts/generate-mod-catalog.ts \
  --count 100 \
  --modpack-count 100 \
  --versions-per-mod 3 \
  --concurrency 8 \
  --output scripts/mod-catalog-100.json
```

Build the offline snapshot:

```bash
pnpm exec tsx scripts/offline-pipeline/run.ts \
  --catalog-file scripts/mod-catalog-100.json \
  --fresh \
  --verbose
```

Copy the resulting snapshot id, then run ground truth:

```bash
pnpm truth:run -- \
  --offline-snapshot <SNAPSHOT_ID> \
  --limit 25 \
  --concurrency 2 \
  --created-by usr_pipeline
```

Important:
- `--limit 25` means "attempt up to 25 candidates"
- `--concurrency 2` means "run 2 Forge instances at the same time"

Once that is stable, increase carefully:

```bash
pnpm truth:run -- \
  --offline-snapshot <SNAPSHOT_ID> \
  --limit 50 \
  --concurrency 3 \
  --created-by usr_pipeline
```

Do not jump straight to high concurrency. Stability matters more than one noisy benchmark.

## 8. Recommended First Cloud Iteration

Use this order:

1. Launch the service
2. Install prerequisites
3. Clone the repo
4. Configure `.env`
5. Run `pnpm typecheck`
6. Run the offline pipeline
7. Run `truth:run` with `--concurrency 2`
8. Inspect results before scaling up

## 9. If The Service Restarts

If you enabled persistence, your repo and caches should remain in place. After reconnecting:

```bash
cd ~/modcompat
. "$HOME/.nvm/nvm.sh"
nvm use 22
corepack enable
pnpm -v
```

Then resume with the next pipeline command.

## 10. Troubleshooting

If `pnpm` is missing after reconnect:

```bash
corepack enable
corepack prepare pnpm@10.0.0 --activate
```

If Forge cannot start:
- check `GROUND_TRUTH_FORGE_TEMPLATE_DIR`
- check that `run.sh` is executable
- keep `GROUND_TRUTH_FORGE_LAUNCH_COMMAND` blank unless you have a custom template
- verify Java 17 is installed

If the machine becomes unstable during ground truth:
- lower `GROUND_TRUTH_CONCURRENCY`
- lower `--limit`
- inspect disk usage under `.ground-truth-workdir` and `.ground-truth-cache`

If network fetching is slow:
- keep the local caches
- do not delete `.offline-cache` or `.ground-truth-cache` between cloud runs unless you need a true reset
