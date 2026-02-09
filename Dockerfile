FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:web && npm prune --omit=dev

# ---

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    iputils-ping iproute2 net-tools && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/out/web/ ./out/web/
COPY --from=builder /app/dist/renderer/ ./dist/renderer/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/package.json ./

ENV ANETI_DATA_DIR=/var/lib/aneti
VOLUME /var/lib/aneti

EXPOSE 8787

CMD ["node", "out/web/web.js"]
