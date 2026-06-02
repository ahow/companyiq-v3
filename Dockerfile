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

# Build client
RUN ./node_modules/.bin/vite build --outDir dist/client client

EXPOSE 3000

CMD ["node", "--import", "tsx", "server/index.ts"]
