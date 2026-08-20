# Conarium — self-hosted MCP governance server
# Multi-stage: build with the full toolchain, ship only the runtime.
#
# The base image is pinned by digest, not by tag. `node:20-slim` is a moving
# reference: the same Dockerfile built twice can produce two different images,
# so what a reader verified is not necessarily what they ran. A digest names one
# image and nothing else.
#
# A pin that nobody advances is a stale base image with unpatched CVEs, which is
# worse than the tag it replaced. The digest is therefore an update channel, not
# a freeze: .github/dependabot.yml watches the `docker` ecosystem for this file
# and opens the bump as a reviewable pull request.

# --- build stage ---
FROM node:26-slim@sha256:4ebb5ace66f15a24c14c492e01a8beeed4fddf970a856109f5126e703e5fe503 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build            # tsc -> dist/

# --- runtime stage ---
FROM node:26-slim@sha256:4ebb5ace66f15a24c14c492e01a8beeed4fddf970a856109f5126e703e5fe503 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY bin/conarium-docker-entry.mjs ./bin/conarium-docker-entry.mjs

# Conarium is an MCP stdio server. Your AI client launches it and speaks MCP
# over stdio; mount your policy + config read-only at run time. It never needs
# an inbound port, and it never phones home.
#   docker run --rm -i \
#     -v "$PWD/conarium.config.json:/app/conarium.config.json:ro" \
#     conarium --config /app/conarium.config.json
#
# Entry goes through conarium-docker-entry.mjs rather than dist/index.js
# directly. Conarium refuses to start without an audit signing key, which is
# correct and stays; the entry script mints a throwaway key when none is
# mounted so a bare `docker run` can answer an introspection request instead of
# exiting at boot. It warns on stderr and does nothing when you mount a key.
ENTRYPOINT ["node", "bin/conarium-docker-entry.mjs"]
