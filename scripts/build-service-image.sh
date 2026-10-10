#!/usr/bin/env bash
# Fargate tasks are ARM64. Always pass --platform linux/arm64.
# An x86 image fails at task start with "exec format error" and the ECS deployment rolls back.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
docker build \
  --platform linux/arm64 \
  -f "${root}/infra/aws/docker/service.Dockerfile" \
  -t otel-demo-service \
  "${root}"
