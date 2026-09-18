# ---- 构建阶段 ----
FROM node:20-alpine AS build
WORKDIR /app

# 优先拷贝依赖清单，利用层缓存（无 package-lock.json 时按 package.json 安装）
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; \
    else npm install --no-audit --no-fund; fi

# 编译 TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 去掉开发依赖，只保留生产依赖
RUN npm prune --omit=dev

# ---- 运行阶段 ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# 以非 root 用户运行
RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
COPY package.json ./package.json

USER app
EXPOSE 3000

CMD ["node", "dist/server.js"]
