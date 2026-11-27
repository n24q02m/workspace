# workspace - Google Workspace MCP server, optimized for AI agents
# Multi-target Dockerfile: `stdio` and `http` stages. CD builds with no `target`, so
# every published tag is the LAST stage (`http`); the `stdio` stage is only built
# locally (`target: stdio` in docker-compose.yml).
# syntax=docker/dockerfile:1

# Use bun for dependency installation
FROM oven/bun:1-alpine@sha256:da816670775f4c2b4e990b6b1847cf5540dcdc721a42033dd331ce7a88ba6a3b AS deps

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Use Node.js for building (tsc + esbuild)
FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY . .

# Build the package
RUN npm run build

# Base runtime stage (shared by both targets)
FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS base

LABEL org.opencontainers.image.source="https://github.com/n24q02m/workspace"
LABEL io.modelcontextprotocol.server.name="io.github.n24q02m/workspace"

# Copy built package from builder stage
COPY --from=builder /app/build /usr/local/lib/node_modules/@n24q02m/workspace/build
COPY --from=builder /app/bin /usr/local/lib/node_modules/@n24q02m/workspace/bin
COPY --from=builder /app/package.json /usr/local/lib/node_modules/@n24q02m/workspace/
COPY --from=builder /app/README.md /usr/local/lib/node_modules/@n24q02m/workspace/
COPY --from=builder /app/LICENSE /usr/local/lib/node_modules/@n24q02m/workspace/
COPY --from=builder /app/node_modules /usr/local/lib/node_modules/@n24q02m/workspace/node_modules

# Create symlinks for CLI (workspace + legacy better-workspace-mcp alias)
RUN ln -s /usr/local/lib/node_modules/@n24q02m/workspace/bin/cli.mjs /usr/local/bin/workspace \
    && ln -s /usr/local/lib/node_modules/@n24q02m/workspace/bin/cli.mjs /usr/local/bin/better-workspace-mcp \
    && chmod +x /usr/local/lib/node_modules/@n24q02m/workspace/bin/cli.mjs

ENV NODE_ENV=production

USER node

# stdio target: direct MCP SDK StdioServerTransport (no daemon hop). Not published as
# a tag; build it locally (docker-compose.yml, `target: stdio`).
FROM base AS stdio
ENV MCP_TRANSPORT=stdio
ENTRYPOINT ["node", "/usr/local/lib/node_modules/@n24q02m/workspace/bin/cli.mjs"]

# http target: hull runHttpServer with per-user bearer auth (src/transports/http.ts).
# Last stage, so every published tag runs it. Self-hosted deployment.
FROM base AS http
ENV MCP_TRANSPORT=http
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["node", "/usr/local/lib/node_modules/@n24q02m/workspace/bin/cli.mjs"]
