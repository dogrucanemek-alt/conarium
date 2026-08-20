# ClusterFuzzLite / OSS-Fuzz build image for the Jazzer.js targets.
# JavaScript cannot use address sanitizer; the CI workflows invoke Jazzer
# directly for the same reason. This file is the application-shaped build.
# Pinned by digest for the same reason as the runtime image, and bumped through
# the same dependabot channel: see the note at the top of ./Dockerfile.
FROM node:26-bookworm@sha256:0353e48e0e8a993db87b720c242f54b207059d1bcc0106534896e8a11054c837

WORKDIR /src
COPY . /src
COPY .clusterfuzzlite/build.sh /src/build.sh
RUN chmod +x /src/build.sh
