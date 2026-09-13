FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/admin-ui/package.json packages/admin-ui/
COPY packages/extension/package.json packages/extension/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w @sf-claws/shared && npm run build -w @sf-claws/server && npm run build -w @sf-claws/admin-ui

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/server ./packages/server
COPY --from=build /app/packages/admin-ui/dist ./packages/admin-ui/dist
COPY --from=build /app/skills ./skills
WORKDIR /app/packages/server
ENV DATA_DIR=/data ADMIN_UI_DIST=../admin-ui/dist SKILLS_SEED_DIR=../../skills PORT=8787
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "dist/index.js"]
