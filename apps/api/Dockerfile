# NODAQ API (Fastify) — image monorepo pour Scaleway Serverless Containers.
# Contexte de build = RACINE du repo :  docker build -f apps/api/Dockerfile .

FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY mcp-servers ./mcp-servers
RUN pnpm install --frozen-lockfile
# prisma generate (build de @nodaq/db) + tsc de toute la chaîne de dépendances.
RUN pnpm --filter @nodaq/api... build

FROM node:22-slim
ENV NODE_ENV=production
# Prisma (moteur natif) exige libssl à l'exécution — node:22-slim ne l'embarque
# pas ("failed to detect libssl/openssl" puis crash aux requêtes).
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
# Le workspace complet : node_modules pnpm (symlinks) + dist. Plus lourd qu'un
# `pnpm deploy`, mais fidèle au graphe workspace:* sans étape fragile.
COPY --from=build --chown=node:node /repo .
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
