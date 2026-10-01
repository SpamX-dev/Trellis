FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY trellis-framework/package.json ./trellis-framework/package.json
RUN npm ci
COPY trellis-knowledge ./trellis-knowledge
RUN npm run build:api

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY trellis-framework/package.json ./trellis-framework/package.json
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY trellis-knowledge/server/migrations ./trellis-knowledge/server/migrations
ENV NODE_ENV=production PORT=3000 GIT_ROOT=/data/repositories
EXPOSE 3000
CMD ["node", "dist/trellis-knowledge/server/main.js"]
