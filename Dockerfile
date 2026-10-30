# Production image: the authoritative server, which also serves the built Trainer.
FROM node:24.21.0-slim AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
# Replace the full workspace install with the server bundle's external runtime dependencies.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
  && pnpm install --frozen-lockfile --prod --filter @poker/server

FROM node:24.21.0-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/node_modules apps/server/node_modules
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
# deploy.sh installs the Compose file released with this image.
COPY deploy/compose.yaml deploy/
USER node
EXPOSE 3001
CMD ["node", "apps/server/dist/main.js"]
