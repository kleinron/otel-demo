# Build from the repo root:
#   npm run image:build
# which is: docker build --platform linux/arm64 -f infra/aws/docker/service.Dockerfile .
# Fargate tasks are ARM. An x86 image fails at task start with "exec format error"
# and the ECS deployment rolls back. The TARGETARCH check below rejects that build.
# Push the tag `demo` to each service ECR repository before a real deploy.
# This image is not built by synth or CI.
FROM public.ecr.aws/docker/library/node:22-alpine
ARG TARGETARCH
RUN if [ "$TARGETARCH" != "arm64" ]; then \
      echo "Build with --platform linux/arm64. Fargate tasks are ARM; an x86 image fails with exec format error and the ECS deployment rolls back." >&2; \
      exit 1; \
    fi
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY loadgen ./loadgen
# Scheduled faults read this path. Keep the file even if the loadgen copy above changes.
COPY loadgen/schedule.json /app/loadgen/schedule.json
RUN test -f /app/loadgen/schedule.json
COPY infra/aws/docker/fault-switch.cjs /opt/fault-switch/fault-switch.cjs
# infra/aws is not copied into the image, so build only the runtime workspaces.
RUN npm ci && npx tsc -b services/shop services/inventory services/payment services/delivery loadgen \
  && npm install --prefix /opt/fault-switch @aws-sdk/client-ssm@3.901.0
ENV LOG_LEVEL=info
WORKDIR /app
