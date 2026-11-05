# Assembles images from the binaries in dist/, built by `make bins` (static musl).
# Compiling once per architecture on native runners is far faster than under QEMU,
# and the images then hold exactly the binaries shipped in the packages.
FROM alpine:3.22 AS base
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 nyx
COPY LICENSE THIRD-PARTY.md licenses/UFL-1.0.txt /usr/share/doc/nyx/

# PocketBase is embedded in these binaries, and its data lives in this volume.
FROM base AS server
ENV NYX_DATA_DIR=/data
RUN install -d -o nyx /data
VOLUME /data

FROM server AS monitor
ARG TARGETARCH
COPY dist/linux-${TARGETARCH}/nyx-monitor /usr/local/bin/
COPY dist/linux-${TARGETARCH}/nyx-notify /usr/local/bin/
COPY dist/linux-amd64/nyx-agent /usr/share/nyx/agents/nyx-agent-linux-x86_64
COPY dist/linux-arm64/nyx-agent /usr/share/nyx/agents/nyx-agent-linux-aarch64
USER nyx
EXPOSE 8081
ENTRYPOINT ["nyx-monitor"]

FROM server AS manager
ARG TARGETARCH
COPY dist/linux-${TARGETARCH}/nyx-manager /usr/local/bin/
COPY dist/linux-${TARGETARCH}/nyx-notify /usr/local/bin/
USER nyx
EXPOSE 8082
ENTRYPOINT ["nyx-manager"]

# The optional shared database. See docs/deployment.md before publishing its port.
FROM server AS db
ARG TARGETARCH
COPY dist/linux-${TARGETARCH}/nyx-db /usr/local/bin/
USER nyx
EXPOSE 8090
ENTRYPOINT ["nyx-db"]

# Runs as root with host namespaces: see docs/deployment.md.
FROM base AS agent
ARG TARGETARCH
RUN apk add --no-cache smartmontools
COPY dist/linux-${TARGETARCH}/nyx-agent /usr/local/bin/
ENTRYPOINT ["nyx-agent", "run"]
