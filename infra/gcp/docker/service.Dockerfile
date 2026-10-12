# GCP image for all four services, the seed job, and the load tick job.
# Cloud Run runs linux/amd64. Build it with Cloud Build from the repo root:
#   gcloud builds submit --config infra/gcp/docker/cloudbuild.yaml \
#     --substitutions _IMAGE=REGION-docker.pkg.dev/PROJECT/otel-demo/service:TAG .
# The AWS image (infra/aws/docker/service.Dockerfile) stays arm64-only.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY loadgen ./loadgen
COPY scripts ./scripts
COPY infra/aws/package.json infra/aws/tsconfig.json ./infra/aws/
COPY infra/aws/src ./infra/aws/src
COPY infra/gcp/package.json infra/gcp/tsconfig.json ./infra/gcp/
COPY infra/gcp/src ./infra/gcp/src
# tsx stays installed so the seed job can run scripts/seed.ts.
RUN npm ci --ignore-scripts \
  && npx tsc -b packages/telemetry packages/db packages/httpkit services/shop services/inventory \
     services/payment services/delivery loadgen infra/gcp \
  && chown -R node:node /app
ENV NODE_ENV=production
ENV LISTEN_ANY=true
ENV LOG_LEVEL=info
USER node
CMD ["node", "services/shop/dist/index.js"]
