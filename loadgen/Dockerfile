# node:22-bookworm-slim publishes linux/arm64 and linux/amd64. No arch-specific packages.
FROM node:22-bookworm-slim
WORKDIR /app
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev && chown -R node:node /app
ENV NODE_ENV=production
USER node
CMD ["node", "loadgen/dist/main.js"]
