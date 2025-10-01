# Playwright runtime with Chromium already installed
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# your server
COPY server.js ./

# health
EXPOSE 8080
CMD ["node","server.js"]
