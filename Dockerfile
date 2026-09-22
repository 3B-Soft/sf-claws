FROM oven/bun:1.3.12-debian AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/admin-ui/package.json packages/admin-ui/
COPY packages/extension/package.json packages/extension/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run --filter @sf-claws/shared build && bun run --filter @sf-claws/server build && bun run --filter @sf-claws/admin-ui build

FROM oven/bun:1.3.12-debian
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/bun.lock /app/bunfig.toml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/server ./packages/server
COPY --from=build /app/packages/admin-ui/dist ./packages/admin-ui/dist
COPY --from=build /app/skills ./skills
WORKDIR /app/packages/server
ENV DATA_DIR=/data ADMIN_UI_DIST=../admin-ui/dist SKILLS_SEED_DIR=../../skills PORT=8787
VOLUME ["/data"]
EXPOSE 8787
CMD ["bun", "dist/index.js"]
