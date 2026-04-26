FROM node:22-bookworm-slim

ARG SERVICE_DIR

RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY apps ./apps
COPY packages ./packages
COPY fixtures ./fixtures
COPY rules ./rules
COPY schemas ./schemas

RUN pnpm install --frozen-lockfile

WORKDIR /app/${SERVICE_DIR}

CMD ["node", "--import", "tsx", "src/index.ts"]
