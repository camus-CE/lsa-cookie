# Playwright runtime with Chromium already installed
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app
COPY package*.json ./

# Skip downloading browsers (already in this image) and install deps.
# Use lockfile if present; otherwise fall back to npm install.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# your server
COPY server.js ./

EXPOSE 8080
CMD ["node","server.js"]
