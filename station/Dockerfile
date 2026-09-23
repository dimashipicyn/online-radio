FROM node:20-slim

RUN sed -i 's|deb.debian.org|mirror.yandex.ru|g; s|security.debian.org|mirror.yandex.ru|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true \
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src

USER node
ENV NODE_ENV=production

EXPOSE 3000
CMD ["node", "src/index.js"]
