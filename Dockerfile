FROM mcr.microsoft.com/playwright:v1.55.1-jammy

WORKDIR /app
COPY package*.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY server.js ./
EXPOSE 8080
CMD ["node","server.js"]
