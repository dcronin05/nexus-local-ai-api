FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# ─── Production image ────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Copy only what's needed to run
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# Data directory for usage tracking persistence
RUN mkdir -p /app/data
VOLUME /app/data

ENV NODE_ENV=production
ENV NEXUS_PORT=3060
ENV NEXUS_DATA_DIR=/app/data

EXPOSE 3060

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3060/api/status || exit 1

CMD ["node", "dist/index.js"]
