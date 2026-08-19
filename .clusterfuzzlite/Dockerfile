# ClusterFuzzLite / OSS-Fuzz build image for the Jazzer.js targets.
# JavaScript cannot use address sanitizer; the CI workflows invoke Jazzer
# directly for the same reason. This file is the application-shaped build.
# Pinned by digest for the same reason as the runtime image, and bumped through
# the same dependabot channel: see the note at the top of ./Dockerfile.
FROM node:20-bookworm@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5

WORKDIR /src
COPY . /src
COPY .clusterfuzzlite/build.sh /src/build.sh
RUN chmod +x /src/build.sh
