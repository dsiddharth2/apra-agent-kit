# Azure Functions deployment

Full guide: [docs/deploy-azure-functions.md](../../docs/deploy-azure-functions.md).

Quick reference:

    # build and run locally against Azurite (same as CI)
    docker compose -f docker-compose.e2e.yml --profile durable up -d --wait agent-durable
    BASE_URL=http://agent-durable/api E2E_TARGET=durable docker compose -f docker-compose.e2e.yml run --rm e2e
    docker compose -f docker-compose.e2e.yml --profile durable down -v

    # push to Azure (Premium plan, custom container)
    az acr build -r <registry> -t apra-agent-kit-functions:latest -f deploy/azure-functions/Dockerfile .
    az functionapp create -g <rg> -n <app> -p <premium-plan> -s <storage> \
      --functions-version 4 --runtime node --image <registry>.azurecr.io/apra-agent-kit-functions:latest
    az functionapp config appsettings set -g <rg> -n <app> --settings \
      JOBS_BACKEND=durable DURABLE_TASK_HUB=fleetjobs WORKER_POOL_SIZE=0 WORKER_EPHEMERAL_MAX=2 \
      CLAUDE_CODE_OAUTH_TOKEN=<token>
