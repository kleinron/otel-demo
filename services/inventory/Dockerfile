FROM node:22-bookworm-slim
WORKDIR /app
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev && chown -R node:node /app
ENV NODE_ENV=production
ENV LISTEN_ANY=true
USER node
EXPOSE 3002
CMD ["node", "services/inventory/dist/index.js"]
