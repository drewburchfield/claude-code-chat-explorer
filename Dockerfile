# Multi-stage build for smaller image size
# Stage 1: Build native modules
FROM node:20-alpine AS builder

# Install build dependencies for better-sqlite3 (native module) + curl for safe-chain installer
RUN apk add --no-cache python3 make g++ curl

# Aikido safe-chain: blocks known-malicious npm packages at install time and
# suppresses packages younger than the configured age (default 48h) so a brand
# new compromised version can't slip in during a build. Pinned to 1.5.3 so a
# future safe-chain regression can't break this image build.
RUN curl -fsSL https://github.com/AikidoSec/safe-chain/releases/download/1.5.3/install-safe-chain.sh \
    | sh -s -- --ci
ENV PATH="/root/.safe-chain/shims:/root/.safe-chain/bin:${PATH}"

WORKDIR /app

# Copy package files first for better cache utilization
COPY package*.json ./

# `npm ci` (not `npm install`) so the build is reproducible against
# package-lock.json. `--omit=dev` skips devDependencies for the runtime image.
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/

## Stage 1b: Test runner (includes devDependencies)
## Commented out to keep the runtime image/compose focused; can be re-enabled as needed.
## FROM node:20-alpine AS test
##
## # Install build dependencies for better-sqlite3 (native module)
## RUN apk add --no-cache python3 make g++
##
## WORKDIR /app
##
## # Install full dependency graph for tests (includes devDependencies like vitest)
## COPY package*.json ./
## RUN npm ci
##
## # Copy source + tests
## COPY src/ ./src/
## COPY test/ ./test/
## COPY vitest.config.js ./
##
## # Default to running unit + integration tests
## CMD ["npm", "test"]

# Stage 2: Production runtime (minimal Alpine)
FROM node:20-alpine

# Accept build argument for user ID (will be passed from docker-compose)
ARG USER_ID=1000

# Create user with matching UID
RUN adduser -D -u ${USER_ID} appuser && \
    mkdir -p /home/appuser/.claude && \
    mkdir -p /data && \
    chown -R appuser:appuser /home/appuser /data

WORKDIR /app

# Copy built application from builder stage
COPY --from=builder --chown=appuser:appuser /app ./

# Switch to non-root user
USER appuser

# Expose port 9876 (the port used by --chats)
EXPOSE 9876

# Run chats-mobile directly
CMD ["node", "-e", "require('./src/chats-mobile.js').startChatsMobile()"]
