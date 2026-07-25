# NODAQ web (Next.js standalone) — Scaleway Serverless Containers.
# Contexte de build = RACINE du repo :  docker build -f apps/web/Dockerfile .
# API_URL est lu AU BUILD (les rewrites Next sont figés dans le manifest).

FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
ARG API_URL=http://localhost:8080
ENV API_URL=$API_URL
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY mcp-servers ./mcp-servers
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @nodaq/web... build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
# Sortie standalone monorepo : server.js sous apps/web/, node_modules minimal.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/web/server.js"]
