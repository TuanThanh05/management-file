# Backend API. Dựng: docker compose --profile app up -d --build
# Bước 1: cài thư viện (bỏ devDependencies) bằng image Node chính thức
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Bước 2: image chạy trên Ubuntu 24.04 để có mysqldump bản MySQL 8 (sao lưu); chạy bằng user thường
FROM ubuntu:24.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends mysql-client-core-8.0 ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
RUN useradd --system --uid 10001 --home-dir /app app \
 && mkdir -p /data/storage /backups && chown app:app /data/storage /backups
USER app
ENV NODE_ENV=production PORT=3000 STORAGE_DIR=/data/storage BACKUP_DIR=/backups MYSQLDUMP_PATH=/usr/bin/mysqldump
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
