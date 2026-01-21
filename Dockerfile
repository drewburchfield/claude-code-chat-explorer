# Multi-stage build for smaller image size
# Stage 1: Build native modules
FROM node:20-alpine AS builder

# Install build dependencies for better-sqlite3 (native module)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files first for better cache utilization
COPY package*.json ./

# Install all dependencies including devDependencies for building
RUN npm install --omit=dev

# Copy source code
COPY src/ ./src/

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
