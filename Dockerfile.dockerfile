# Playwright image that includes Chromium
FROM mcr.microsoft.com/playwright:v1.55.1-jammy

WORKDIR /app
COPY server.js ./

# Install only what we need
RUN npm init -y && npm i express

# defaults (can be overridden by env in Sliplane)
ENV PROFILE_DIR=/config/profile \
    PROFILE_NAME=Default \
    WAIT_UNTIL=domcontentloaded \
    COOKIE_TTL_MS=3600000 \
    PORT=8080

EXPOSE 8080
CMD ["node","server.js"]
