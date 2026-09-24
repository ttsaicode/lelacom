# Universal Multi-Platform Dockerfile
FROM node:22-alpine

WORKDIR /app

# Copy dependency manifests first for build caching
COPY package*.json ./

# Install dependencies cleanly
RUN npm ci --omit=dev

# Copy application codebase
COPY . .

# Set environment defaults
ENV PORT=3000 \
    NODE_ENV=production

EXPOSE 3000

# Health check endpoint for container orchestrators (AWS ECS, GCP Cloud Run, DigitalOcean, VPS)
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/ || exit 1

CMD ["node", "server.cjs"]
