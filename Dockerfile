FROM node:22-slim

# Install pnpm and chromium dependencies
RUN npm install -g pnpm && \
    apt-get update && \
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

# Copy package files and config
COPY package.json pnpm-lock.yaml* .npmrc ./

# Install dependencies (skip puppeteer download since we use system chromium)
RUN pnpm config set ignore-scripts false && \
    PUPPETEER_SKIP_DOWNLOAD=true pnpm install --no-frozen-lockfile

# Copy source
COPY . .

# Build client
RUN cd client && ../node_modules/.bin/vite build

EXPOSE 3000

CMD ["node", "--import", "tsx", "server/index.ts"]
