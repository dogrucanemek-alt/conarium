# Conarium — self-hosted MCP governance server
# Multi-stage: build with the full toolchain, ship only the runtime.

# --- build stage ---
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build            # tsc -> dist/

# --- runtime stage ---
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Conarium is an MCP stdio server. Your AI client launches it and speaks MCP
# over stdio; mount your policy + config read-only at run time. It never needs
# an inbound port, and it never phones home.
#   docker run --rm -i \
#     -v "$PWD/conarium.config.json:/app/conarium.config.json:ro" \
#     conarium --config /app/conarium.config.json
ENTRYPOINT ["node", "dist/index.js"]
