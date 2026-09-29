# ---------- 构建阶段：装原生编译链，保证 better-sqlite3 在无预编译包时也能编出来 ----------
FROM node:22-bookworm-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# ---------- 运行阶段：只带 node_modules 和源码，不带编译链 ----------
FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_FILE=/data/workbench.db
ENV CLIENT_DIR=/app/client

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY server/package.json ./package.json
COPY server/src ./src
COPY client ./client

# 数据卷挂载点先建好并授权，容器以非 root 运行
RUN mkdir -p /data \
 && chown -R node:node /app /data

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
