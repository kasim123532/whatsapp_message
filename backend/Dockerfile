# Build stage
FROM node:20-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY prisma ./prisma/
RUN npx prisma generate

COPY . .
RUN npm run build

# Production stage
FROM node:20-slim

# Install Chromium and dependencies for Puppeteer
# tzdata is what lets the TZ environment variable resolve to a real zone; the
# slim image ships without it and would silently fall back to UTC.
RUN apt-get update && apt-get install -y \
    chromium tzdata \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables for production and Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# Copy dependency configs
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Copy built code and prisma artifacts from build stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY prisma ./prisma/
# Pinned WhatsApp Web bundle (must match PINNED_WEB_VERSION in src/whatsapp.ts).
# Without this the strict local cache throws on every launch.
COPY --from=build /app/.wwebjs_cache ./.wwebjs_cache

EXPOSE 5000

# Start server
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/server.js"]
