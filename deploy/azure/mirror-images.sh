#!/usr/bin/env bash
set -euo pipefail

#=============================================================================
# BilleChat — Mirror third-party images into ACR
#
# Bitnami stopped maintaining its free Docker Hub catalog: `bitnami/*:latest`
# moves between major versions and `bitnamilegacy/*` may disappear. The Helm
# values pin these mirrors by digest, so a node replacement or a new cluster
# pulls exactly the build the data volumes were written with.
#
# To bump an image: change its source digest and mirror tag below, run this
# script, then update the matching tag/digest in billechat-values.yaml or
# code-interpreter/values.yaml.
#
# Usage:
#   ./deploy/azure/mirror-images.sh
#=============================================================================

ACR_NAME="${ACR_NAME:-billechatacr}"
SUBSCRIPTION="${SUBSCRIPTION:-BL-TRANSFORMATION-POC}"

IMAGES=(
  "docker.io/bitnami/mongodb@sha256:e46cffb6627482d0c1e1769746d938c0b926e8ca0a0ddea55c6b58c2bae3eb26 mirror/bitnami-mongodb:8.3.11"
  "docker.io/bitnami/redis@sha256:ffa455a3ad00bccc24dfde113ef55329dde687da242e9feb6ccd2b30eb93e8f3 mirror/bitnami-redis:8.10.1"
  "ghcr.io/bat-bs/bitnami-pgvector@sha256:19ebe07b4dafb9fe5e757e0099947be9fd35d209d4ff371022180419053d426f mirror/bitnami-pgvector:pg16-19ebe07"
  "docker.io/bitnamilegacy/minio@sha256:953d489a81cc4de7975f90e07202189c4325da39b0b92470b6a13c7ea99e36cd mirror/bitnami-minio:2025.7.23-debian-12-r3"
  "docker.io/bitnamilegacy/minio-object-browser@sha256:4ca163354c4f4e2cf87a0c6cf668f47d07f7f176b53d9bd4bd16b81df62b2763 mirror/bitnami-minio-object-browser:2.0.2-debian-12-r3"
  "registry.librechat.ai/danny-avila/librechat-rag-api-dev-lite@sha256:f9f34c8ed6884b0ff9b17387e6174fed737dba29f21622ecb75604d82bc47bf8 mirror/librechat-rag-api-dev-lite:f9f34c8"
)

for entry in "${IMAGES[@]}"; do
  read -r source target <<< "${entry}"
  echo "▸ ${target}"
  az acr import \
    --name "${ACR_NAME}" \
    --subscription "${SUBSCRIPTION}" \
    --source "${source}" \
    --image "${target}" \
    --force \
    --output none
done
