FROM node:20.11.1-alpine

WORKDIR /app

# Install dependencies using the lockfile (repeatable)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code into the image
COPY . .

EXPOSE 3000

ENV NODE_ENV=production
CMD ["node", "index.js"]
