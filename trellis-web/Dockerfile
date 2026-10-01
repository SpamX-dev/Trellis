FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY trellis-framework/package.json ./trellis-framework/package.json
RUN npm ci
COPY trellis-web ./trellis-web
RUN npm run build:web

FROM nginx:1.29-alpine
COPY trellis-web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist-web /usr/share/nginx/html
EXPOSE 80
