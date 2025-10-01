FROM mcr.microsoft.com/playwright:v1.55.1-jammy

WORKDIR /app

# install deps first for better caching
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# app code
COPY server.js ./

ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
