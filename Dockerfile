# ---- base ----
FROM node:20.11.1-alpine AS base
WORKDIR /app

# ---- deps (prod deps only) ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM base AS runtime
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 3000
CMD ["npm", "start"]
