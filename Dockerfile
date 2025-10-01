# Base image that already has browsers & system deps
FROM mcr.microsoft.com/playwright:v1.55.1-jammy

WORKDIR /app

# Install only prod deps (playwright + express) from package.json
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# App code
COPY server.js ./

# App config
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
CMD ["npm", "start"]
