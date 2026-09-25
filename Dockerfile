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
      poppler-utils \
      tesseract-ocr \
      tesseract-ocr-eng \
      tini \
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

# Run tini as PID 1 so orphaned/reparented child processes are reaped.
# Root cause: with `node` as PID 1 and no init, when Chromium (spawned by
# Puppeteer) crashes or is killed its helper/child processes are reparented to
# PID 1. Node as PID 1 does not reap arbitrary reparented children, so they
# accumulate as zombies holding PID slots until the container's pids cgroup /
# RLIMIT_NPROC cap is hit, after which every fork() fails with EAGAIN
# ("Cannot fork" / posix_spawn errno 11) and no further browser can launch.
# tini reaps zombies, and `-g` forwards signals to the whole process group so
# Chromium subprocess trees are cleaned up on shutdown. ENTRYPOINT persists even
# when CMD is overridden, so every Railway service (worker + app) gets a proper
# init as PID 1 regardless of its start command.
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]

CMD ["node", "--import", "tsx", "server/index.ts"]
