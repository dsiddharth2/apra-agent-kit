FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     python3 python3-pip ca-certificates git make g++ \
  && update-ca-certificates \
  && pip install --no-cache-dir --break-system-packages certifi \
  && npm install -g @apralabs/apra-fleet @anthropic-ai/claude-code \
  && apra-fleet install --skill none \
  && apt-get purge -y --auto-remove make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Use npm install — a generated project ships without a lockfile.
# Commit the lockfile npm writes here to enable lockfile-based installs.
COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "mcp/main.mjs"]
