# Build context = repo root (monorepo workspace install needs every package.json).
# Railway: railway.json points here via dockerfilePath.
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --cwd apps/room build

FROM oven/bun:1.3-slim
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
EXPOSE 19434
CMD ["bun", "run", "apps/room/targets/bun.ts"]
