# Build context = repo root (monorepo workspace install needs every package.json).
# Railway: railway.json points here via dockerfilePath.
FROM oven/bun:1.3.11 AS build
WORKDIR /app
# node-pty 등 네이티브 모듈 컴파일용 툴체인
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --cwd apps/room build

FROM oven/bun:1.3.11-slim
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
EXPOSE 19434
CMD ["bun", "run", "apps/room/targets/bun.ts"]
