# ClusterFuzzLite / OSS-Fuzz build image for the Jazzer.js targets.
# JavaScript cannot use address sanitizer; the CI workflows invoke Jazzer
# directly for the same reason. This file is the application-shaped build.
FROM node:20-bookworm

WORKDIR /src
COPY . /src
COPY .clusterfuzzlite/build.sh /src/build.sh
RUN chmod +x /src/build.sh
