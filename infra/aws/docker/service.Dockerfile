# Build from the repo root:
#   docker build -f infra/aws/docker/service.Dockerfile -t otel-demo-shop .
# Push the tag `demo` to the matching ECR repository before a real deploy.
# This image is not built by synth or CI.
FROM public.ecr.aws/docker/library/node:22-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY loadgen ./loadgen
COPY infra/aws/docker/fault-switch.cjs /opt/fault-switch/fault-switch.cjs
# infra/aws is not copied into the image, so build only the runtime workspaces.
RUN npm ci && npx tsc -b services/shop services/inventory services/payment services/delivery loadgen \
  && npm install --prefix /opt/fault-switch @aws-sdk/client-ssm@3.901.0
ENV LOG_LEVEL=info
WORKDIR /app
