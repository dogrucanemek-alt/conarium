# ClusterFuzzLite / OSS-Fuzz build image for the Jazzer.js targets.
# JavaScript cannot use address sanitizer; the CI workflows invoke Jazzer
# directly for the same reason. This file is the application-shaped build.
# Pinned by digest for the same reason as the runtime image, and bumped through
# the same dependabot channel: see the note at the top of ./Dockerfile.
FROM node:26-bookworm@sha256:fa52d1669505e29b58c042875b1d65c229e0787a3610fd52869b22b68e480853

WORKDIR /src
COPY . /src
COPY .clusterfuzzlite/build.sh /src/build.sh
RUN chmod +x /src/build.sh
