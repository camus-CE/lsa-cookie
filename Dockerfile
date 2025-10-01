# Includes Node + Chromium + all required system libraries
FROM mcr.microsoft.com/playwright:v1.55.1-jammy

USER root

# Make sure /config exists (shared volume for profile)
RUN mkdir -p /config && chmod -R 777 /config

WORKDIR /app

# Copy package manifests first for better cache
COPY package.json package-lock.json* ./

# Avoid slow/noisy steps
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm config set fund false \
 && npm config set update-notifier false \
 && if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# App code
COPY server.js ./

ENV NODE_ENV=production
ENV PROFILE_DIR=/config/.config/chromium
ENV PROFILE_NAME=Default
ENV TARGET_URL=https://ads.google.com/localservices/accountpicker
ENV WAIT_UNTIL=networkidle
ENV COOKIE_TTL_MS=3600000

EXPOSE 8080
CMD ["node", "server.js"]
