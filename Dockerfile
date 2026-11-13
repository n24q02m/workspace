# workspace - Google Workspace MCP server, optimized for AI agents
# Multi-target Dockerfile: `:stdio` (default for clients) + `:http` (self-hosted daemon).
# See spec 2026-04-30-multi-mode-stdio-http-architecture.md.
# syntax=docker/dockerfile:1

# Use bun for dependency installation
FROM oven/bun:1-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS deps

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Use Node.js for building (tsc + esbuild)
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY . .

# Build the package
RUN npx tsc -build && node scripts/build-cli.js

# Base runtime stage (shared by both targets)
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base

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

# stdio target: direct MCP SDK StdioServerTransport (no daemon hop).
# Intended for `docker run --rm -i n24q02m/workspace:stdio` from MCP clients.
FROM base AS stdio
ENV MCP_TRANSPORT=stdio
ENTRYPOINT ["node", "/usr/local/lib/node_modules/@n24q02m/workspace/bin/cli.mjs"]

# http target: HTTP daemon (runLocalServer). Self-hosted deployment.
FROM base AS http
ENV MCP_TRANSPORT=http
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["node", "/usr/local/lib/node_modules/@n24q02m/workspace/bin/cli.mjs"]
