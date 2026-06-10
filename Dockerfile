# Build image
FROM node:22-alpine AS builder

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
RUN npm install
RUN npm ci --no-audit --no-fund

# Copy source and build
COPY tsconfig.json ./
COPY tsconfig.server.json ./
COPY src/ ./src/
COPY submodules/ ./submodules/

ARG VERSION
ENV VERSION=$VERSION
RUN echo "Building with version: ${VERSION}"

RUN npm run build

# Production image - much smaller
FROM node:20-alpine

WORKDIR /app

# Copy only what's needed from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/submodules ./submodules
COPY --from=builder /app/dist ./dist

ENV LOCAL_TIKTOKEN=true
ENV TIKTOKEN_MODEL="o200k_base"

EXPOSE 8788

CMD ["node", "dist/server.js"]
