# Use the same Chromium family as your GUI container
FROM ghcr.io/linuxserver/chromium:latest

# Install Node 20 LTS
USER root
RUN apt-get update \
 && apt-get install -y curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y nodejs \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# server
COPY server.js ./

EXPOSE 8080
CMD ["node", "server.js"]
