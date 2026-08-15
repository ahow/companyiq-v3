FROM node:22-slim

# Install chromium dependencies for puppeteer
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      libnss3 \
      libatk-bridge2.0-0 \
      libx11-xcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxrandr2 \
      libgbm1 \
      libasound2 \
      libpangocairo-1.0-0 \
      libgtk-3-0 \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies using npm (avoids pnpm build script approval issues)
RUN npm install --legacy-peer-deps

# Copy source
COPY . .

# Cache-bust: Railway sets RAILWAY_GIT_COMMIT_SHA as a build arg automatically.
# This ensures Docker invalidates the build layer whenever source code changes,
# even if the COPY layer hash is identical (which can happen with BuildKit).
ARG CACHEBUST=1

# Build client (run from client dir, vite.config.ts has outDir: ../dist/client)
RUN cd client && ../node_modules/.bin/vite build

EXPOSE 3000

CMD ["node", "--import", "tsx", "server/index.ts"]
