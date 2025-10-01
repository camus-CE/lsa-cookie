# Includes Node + Chromium + all required system libraries
FROM mcr.microsoft.com/playwright:v1.55.1-jammy

# (Optional) run as root so /config volume perms are never an issue
USER root

# Make sure /config exists and is writable even before the volume is attached
RUN mkdir -p /config && chmod -R 777 /config

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

ENV NODE_ENV=production
# Set sensible defaults (can still be overridden in Sliplane env)
ENV PROFILE_DIR=/config/.config/chromium
ENV PROFILE_NAME=Default
ENV TARGET_URL=https://ads.google.com/localservices/accountpicker
ENV WAIT_UNTIL=networkidle
ENV COOKIE_TTL_MS=3600000

EXPOSE 8080
CMD ["node", "server.js"]
