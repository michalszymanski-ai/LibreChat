#!/usr/bin/env bash
set -euo pipefail

#=============================================================================
# BilleChat — Azure Infrastructure Provisioning
#
# Creates: Resource Group, ACR, AKS, static ingress IP, Ingress Controller,
#          cert-manager
#
# Prerequisites:
#   - Azure CLI installed and logged in (az login)
#   - kubectl installed
#   - helm installed
#
# Usage:
#   chmod +x deploy/azure/setup-infrastructure.sh
#   ./deploy/azure/setup-infrastructure.sh
#=============================================================================

# ── Configuration ──────────────────────────────────────────────────────────
SUBSCRIPTION="${SUBSCRIPTION:-BL-TRANSFORMATION-POC}"
RESOURCE_GROUP="${RESOURCE_GROUP:-billechat-rg}"
LOCATION="${LOCATION:-swedencentral}"
AKS_CLUSTER="${AKS_CLUSTER:-billechat-aks}"
ACR_NAME="${ACR_NAME:-billechatacr}"
INGRESS_PIP="${INGRESS_PIP:-billechat-ingress-pip}"
# One node is enough for the workload; the 6 Azure Disk PVCs rule out 2-vCPU
# sizes (4 data disks max) and codeapi needs nested virtualization (/dev/kvm).
NODE_COUNT="${NODE_COUNT:-1}"
NODE_VM_SIZE="${NODE_VM_SIZE:-Standard_D4as_v5}"
NODE_OSDISK_GB="${NODE_OSDISK_GB:-64}"
MAX_PODS="${MAX_PODS:-110}"
K8S_VERSION="${K8S_VERSION:-1.34}"
NAMESPACE="${NAMESPACE:-billechat}"
DOMAIN="${DOMAIN:-billechat.billennium.com}"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║         BilleChat Azure Infrastructure Setup            ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Subscription   : ${SUBSCRIPTION}"
echo "║  Resource Group : ${RESOURCE_GROUP}"
echo "║  Location       : ${LOCATION}"
echo "║  AKS Cluster    : ${AKS_CLUSTER}"
echo "║  ACR            : ${ACR_NAME}"
echo "║  Namespace      : ${NAMESPACE}"
echo "║  Domain         : ${DOMAIN}"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── 1. Resource Group ─────────────────────────────────────────────────────
az account set --subscription "${SUBSCRIPTION}"
echo "▸ Creating resource group..."
az group create \
  --name "${RESOURCE_GROUP}" \
  --location "${LOCATION}" \
  --output none

# ── 2. Azure Container Registry ──────────────────────────────────────────
echo "▸ Creating Azure Container Registry..."
az acr create \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${ACR_NAME}" \
  --sku Standard \
  --output none

ACR_LOGIN_SERVER=$(az acr show --name "${ACR_NAME}" --query loginServer -o tsv)
echo "  ACR server: ${ACR_LOGIN_SERVER}"

# ── 3. AKS Cluster ───────────────────────────────────────────────────────
echo "▸ Creating AKS cluster..."
az aks create \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${AKS_CLUSTER}" \
  --nodepool-name system \
  --node-count "${NODE_COUNT}" \
  --node-vm-size "${NODE_VM_SIZE}" \
  --node-osdisk-size "${NODE_OSDISK_GB}" \
  --max-pods "${MAX_PODS}" \
  --os-sku AzureLinux \
  --kubernetes-version "${K8S_VERSION}" \
  --tier free \
  --attach-acr "${ACR_NAME}" \
  --enable-managed-identity \
  --enable-oidc-issuer \
  --node-os-upgrade-channel NodeImage \
  --no-ssh-key \
  --network-plugin azure \
  --output none

# ── 3b. Static ingress IP ────────────────────────────────────────────────
# Owned by the resource group rather than the ingress Service, so DNS keeps
# pointing at the same address across ingress reinstalls and cluster rebuilds.
echo "▸ Creating static ingress IP..."
az network public-ip create \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${INGRESS_PIP}" \
  --sku Standard \
  --allocation-method Static \
  --output none
INGRESS_IP=$(az network public-ip show -g "${RESOURCE_GROUP}" -n "${INGRESS_PIP}" --query ipAddress -o tsv)

AKS_PRINCIPAL_ID=$(az aks show -g "${RESOURCE_GROUP}" -n "${AKS_CLUSTER}" --query identity.principalId -o tsv)
az role assignment create \
  --assignee-object-id "${AKS_PRINCIPAL_ID}" \
  --assignee-principal-type ServicePrincipal \
  --role "Network Contributor" \
  --scope "$(az group show -n "${RESOURCE_GROUP}" --query id -o tsv)" \
  --output none

# ── 4. Get AKS Credentials ───────────────────────────────────────────────
echo "▸ Fetching kubeconfig..."
az aks get-credentials \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${AKS_CLUSTER}" \
  --overwrite-existing

# ── 5. Create Namespace ──────────────────────────────────────────────────
echo "▸ Creating namespace..."
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

# ── 6. Install NGINX Ingress Controller ──────────────────────────────────
echo "▸ Installing NGINX Ingress Controller..."
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx 2>/dev/null || true
helm repo update

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --version 4.15.1 \
  --set controller.replicaCount=2 \
  --set controller.service.annotations."service\.beta\.kubernetes\.io/azure-load-balancer-health-probe-request-path"=/healthz \
  --set controller.service.annotations."service\.beta\.kubernetes\.io/azure-load-balancer-resource-group"="${RESOURCE_GROUP}" \
  --set controller.service.annotations."service\.beta\.kubernetes\.io/azure-pip-name"="${INGRESS_PIP}" \
  --wait

# ── 7. Install cert-manager for TLS ─────────────────────────────────────
echo "▸ Installing cert-manager..."
helm repo add jetstack https://charts.jetstack.io 2>/dev/null || true
helm repo update

helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.20.2 \
  --set crds.enabled=true \
  --wait

# Create ClusterIssuer for Let's Encrypt
echo "▸ Creating Let's Encrypt ClusterIssuer..."
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: devops@billennium.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: nginx
EOF

# ── 8. Get Ingress External IP ───────────────────────────────────────────
echo "▸ Waiting for Ingress external IP..."
EXTERNAL_IP=""
for i in $(seq 1 30); do
  EXTERNAL_IP=$(kubectl get svc ingress-nginx-controller \
    -n ingress-nginx \
    -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
  if [[ -n "${EXTERNAL_IP}" ]]; then
    break
  fi
  echo "  Waiting... (${i}/30)"
  sleep 10
done

# ── 9. Summary ───────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              Infrastructure Ready!                      ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  ACR Login Server : ${ACR_LOGIN_SERVER}"
echo "║  AKS Cluster      : ${AKS_CLUSTER}"
echo "║  Ingress IP       : ${EXTERNAL_IP:-${INGRESS_IP}}"
echo "║  Namespace        : ${NAMESPACE}"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                                                         ║"
echo "║  Next Steps:                                            ║"
echo "║  1. Point DNS A record for ${DOMAIN}"
echo "║     to ${EXTERNAL_IP:-<ingress-ip>}"
echo "║  2. Run: ./deploy/azure/create-secrets.sh               ║"
echo "║  3. Push to billechat branch to trigger deployment      ║"
echo "║                                                         ║"
echo "║  To set up GitHub Actions secrets, run:                 ║"
echo "║  ./deploy/azure/setup-github-secrets.sh                 ║"
echo "╚══════════════════════════════════════════════════════════╝"
