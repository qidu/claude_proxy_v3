# Build image
FROM node:20-alpine AS builder

WORKDIR /app

# Install build tools (no python needed - sharp/esbuild have prebuilt binaries)
RUN apk add --no-cache make g++

# Copy package files first for better caching
COPY package*.json ./

# Modify package.json in a single RUN to reduce layers
RUN sed -i 's/"dev": "wrangler dev",\r$//' package.json && \
    sed -i 's/"dev": "wrangler deploy",\r$//' package.json && \
    sed -i 's/"wrangler": "^4.60.0"\r$//' package.json

# Install dependencies
RUN npm ci --no-audit --no-fund

# Copy source and build
COPY tsconfig.json ./
COPY tsconfig.server.json ./
COPY wrangler.toml ./
COPY src/ ./src/
RUN git rev-parse --short HEAD > /tmp/proxy_version

RUN npm run build

# Production image - much smaller
FROM node:20-alpine

WORKDIR /app

# Copy only what's needed from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=git /tmp/proxy_version /tmp/proxy_version
COPY wrangler.toml ./

ENV VERSION=$(cat /tmp/proxy_version)
ENV LOCAL_TOKEN_COUNTING=true      # Enable local counting
ENV LOCAL_TIKTOKEN=true            # Use tiktoken (accurate)
ENV TIKTOKEN_MODEL=o200k_base      # Encoding model (default: cl100k_base)

EXPOSE 8788

CMD ["node", "dist/server.js"]
