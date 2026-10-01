# syntax=docker/dockerfile:1

# ----------------------------------------------------------------------------
# Stage 1: Builder
# ----------------------------------------------------------------------------
FROM node:22-slim AS builder

WORKDIR /app

# Install native compilation dependencies if needed for optional dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig*.json ./

# Install all dependencies including devDependencies (needed for TypeScript compilation)
RUN npm ci

COPY src/ ./src/

# Compile TypeScript into build/
RUN npm run build

# ----------------------------------------------------------------------------
# Stage 2: Production Runner
# ----------------------------------------------------------------------------
FROM node:22-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

# Install production dependencies only (keep container small and fast)
RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev

# Copy compiled JavaScript output from builder
COPY --from=builder /app/build ./build

# Copy license and metadata
COPY LICENSE README.md server.json ./

# Expose default HTTP transport port (when running in HTTP / both mode)
EXPOSE 3211

# Health check probe for Glama, Docker, and Kubernetes
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3211/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(0))"

# Default entrypoint: runs in STDIO / HTTP MCP server mode
ENTRYPOINT ["node", "build/index.js"]
