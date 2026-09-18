# The same agent as the VM image, hosted by the Azure Functions runtime. Premium plan only.
FROM mcr.microsoft.com/azure-functions/node:4-node22

ENV AzureWebJobsScriptRoot=/home/site/wwwroot \
    AzureFunctionsJobHost__Logging__Console__IsEnabled=true \
    FUNCTIONS_WORKER_RUNTIME=node \
    WORKER_POOL_SIZE=0 \
    WORKER_EPHEMERAL_MAX=2 \
    JOBS_BACKEND=durable \
    DURABLE_TASK_HUB=fleetjobs

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates git curl \
  && update-ca-certificates \
  && pip install --no-cache-dir --break-system-packages certifi \
  && npm install -g @apralabs/apra-fleet @anthropic-ai/claude-code \
  && apra-fleet install --skill none \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /home/site/wwwroot
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --include=optional
COPY . .
# The Functions host loads `main` from this package.json; point it at the Functions entry.
COPY deploy/azure-functions/wwwroot-package.json ./package.json
COPY comm/azure-functions/host.json ./host.json
# Adapter azure-functions + backend durable; replaces the repo's express/in-process config.
COPY deploy/azure-functions/host.config.mjs ./host.config.mjs
RUN node -e "import('./workflows/demo/ensure-apralabs.mjs').then(m => m.ensureApralabs())"

HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=12 \
  CMD curl -fsS http://localhost/api/health || exit 1
