# Multi-stage build for NestJS + Mediasoup SFU
FROM node:22-slim AS builder

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    make \
    g++ \
    gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including mediasoup native bindings)
RUN npm ci

# Copy source code
COPY . .

# Build the NestJS application
RUN npm run build

# Production stage
FROM node:22-slim

# Install only runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy built application from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/frontend ./frontend

# Create a non-root user
RUN useradd -m -u 1001 nestuser && chown -R nestuser:nestuser /app
USER nestuser

# Expose ports
# 3000 - HTTP/WebSocket server
# 40000-49999 - RTC ports for WebRTC media
EXPOSE 3000
EXPOSE 40000-49999/udp
EXPOSE 40000-49999/tcp

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/config', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["node", "dist/main"]

