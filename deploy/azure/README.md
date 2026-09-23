# BilleChat — Azure AKS Deployment

Deploy LibreChat (billechat branch) to Azure Kubernetes Service.

## Architecture

```
Internet → billechat.billennium.com (A → 9.223.181.253, static IP billechat-ingress-pip)
         → Azure Load Balancer
         → NGINX Ingress (TLS via Let's Encrypt)
         → LibreChat Pod (AKS)
             ├── MongoDB (subchart)
             ├── Meilisearch (subchart)
             ├── RAG API + PgVector (subchart)
             ├── Code Interpreter (codeapi, KVM sandbox)
             └── MCP servers (ms365, primetric)
```

## Current Environment

| | |
|---|---|
| Subscription | `BL-TRANSFORMATION-POC` (`b9ac4560-bf0d-41cb-b3e7-1a27bd71ae5d`) |
| Resource group | `billechat-rg` (swedencentral): AKS, ACR `billechatacr`, storage `stbillechatfiles`, Key Vault `kv-billechat`, ingress IP |
| AKS | `billechat-aks`, k8s 1.34, one `Standard_D4as_v5` node (pool `system`, max 110 pods) |
| Ingress IP | `9.223.181.253` (static, survives ingress/cluster rebuilds) |
| Outbound IP | `57.174.174.79` (allowlist this on external services) |

Moved from `BL-AI_DATA_POC` in September 2026. AKS clusters can't change
subscription, so the cluster was rebuilt and its disks copied via snapshots;
ACR, storage and Key Vault were moved with `az resource move`.

LibreChat v0.8.8-rc4 and later refuse to start with the retired default
`JWT_SECRET`/`JWT_REFRESH_SECRET`, so both are unique values in the
`billechat-librechat-env` Secret; rotating them signs every user out once.

The single node is the floor for this workload: the six Azure Disk PVCs rule
out 2-vCPU sizes (4 data disks max), and codeapi needs nested virtualization
(`/dev/kvm`). CPU requests follow observed idle usage; limits allow bursts.

## Prerequisites

- Azure CLI (`az`), kubectl, Helm 3 installed
- Azure subscription with Contributor access
- `gh` CLI (optional, for auto-setting GitHub secrets)

## Deployment Steps

### 1. Provision Azure Infrastructure

```bash
chmod +x deploy/azure/setup-infrastructure.sh
./deploy/azure/setup-infrastructure.sh
```

This creates:
- Resource Group (`billechat-rg`)
- Azure Container Registry (`billechatacr`)
- AKS cluster (`billechat-aks`, 1x Standard_D4as_v5)
- Static public IP for the ingress (`billechat-ingress-pip`)
- NGINX Ingress Controller
- cert-manager with Let's Encrypt

Then mirror the pinned third-party images into ACR:

```bash
./deploy/azure/mirror-images.sh
```

MongoDB, Redis, PgVector, MinIO and the RAG API are pulled from
`billechatacr.azurecr.io/mirror/*` by digest, because Bitnami's free
`latest` tags move between major versions and `bitnamilegacy` may disappear.

### 2. Configure DNS

Point an A record for `billechat.billennium.com` to the static ingress IP printed by the setup script (currently `9.223.181.253`).

### 3. Set Up GitHub Actions Secrets

```bash
chmod +x deploy/azure/setup-github-secrets.sh
./deploy/azure/setup-github-secrets.sh
```

Then manually add these secrets from your `.env`:

| Secret | Source |
|---|---|
| `AZURE_AI_FOUNDRY_API_KEY` | `.env` → `AZURE_AI_FOUNDRY_API_KEY` |
| `OPENID_CLIENT_SECRET` | `.env` → `OPENID_CLIENT_SECRET` |
| `RAG_OPENAI_API_KEY` | `.env` → `RAG_OPENAI_API_KEY` |
| `AZURE_OPENAI_API_KEY` | `.env` → `AZURE_OPENAI_API_KEY` |

### 4. Update Entra ID App Registration

Add the cloud redirect URI to your Entra ID app registration:

```
https://billechat.billennium.com/oauth/openid/callback
```

### 5. Deploy

Push to the `billechat` branch or trigger the workflow manually:

```bash
git push origin billechat
```

The GitHub Actions workflow (`.github/workflows/billechat-deploy.yml`) will:
1. Build the Docker image
2. Push to ACR
3. Deploy to AKS via Helm

### 6. Verify

```bash
az aks get-credentials -g billechat-rg -n billechat-aks
kubectl get pods -n billechat
kubectl get ingress -n billechat
```

## Manual Helm Deployment

For deploying manually without CI/CD:

```bash
# Login to ACR
az acr login --name billechatacr

# Build and push image
docker build -t billechatacr.azurecr.io/billechat:latest .
docker push billechatacr.azurecr.io/billechat:latest

# Deploy
cd helm/librechat && helm dependency build && cd ../..
helm upgrade --install billechat ./helm/librechat \
  --namespace billechat --create-namespace \
  --values deploy/azure/billechat-values.yaml \
  --set image.tag=latest
```

## Configuration

- Helm values: `deploy/azure/billechat-values.yaml`
- LibreChat config: embedded in values via `librechat.configYamlContent`
- CI/CD: `.github/workflows/billechat-deploy.yml`

## Environment Overrides

Override any default via environment variables before running infrastructure scripts:

```bash
export RESOURCE_GROUP=my-custom-rg
export LOCATION=westeurope
export NODE_COUNT=3
./deploy/azure/setup-infrastructure.sh
```
