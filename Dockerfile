# Multi-stage Dockerfile to ensure LibreOffice (soffice) and runtime dependencies are available
FROM node:20-bookworm-slim

# Install LibreOffice, essential fonts, and cleanup apt caches
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer \
    libreoffice-calc \
    fonts-liberation \
    fonts-dejavu \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency specifications first for Docker layer caching
COPY package*.json ./

# Install production and root dependencies
RUN npm install --omit=dev

# Copy application code
COPY . .

# Set environment
ENV NODE_ENV=production
ENV PORT=10000
ENV DOCX_RENDERER_CMD=soffice

EXPOSE 10000

CMD ["node", "server/server.js"]
