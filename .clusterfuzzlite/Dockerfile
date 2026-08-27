# ClusterFuzzLite / OSS-Fuzz build image for the Jazzer.js targets.
# JavaScript cannot use address sanitizer; the CI workflows invoke Jazzer
# directly for the same reason. This file is the application-shaped build.
# Pinned by digest for the same reason as the runtime image, and bumped through
# the same dependabot channel: see the note at the top of ./Dockerfile.
FROM node:25-bookworm@sha256:78839ac448c23517f8eab2e8f7943d9b4f73979eb7f8bed2c73dbf72ff869e7b

WORKDIR /src
COPY . /src
COPY .clusterfuzzlite/build.sh /src/build.sh
RUN chmod +x /src/build.sh
