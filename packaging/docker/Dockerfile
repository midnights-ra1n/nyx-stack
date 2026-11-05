# Assembles images from the binaries in dist/, built by `make bins` (static musl).
# Compiling once per architecture on native runners is far faster than under QEMU,
# and the images then hold exactly the binaries shipped in the packages.
FROM alpine:3.22 AS base
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 nyx
COPY LICENSE THIRD-PARTY.md licenses/UFL-1.0.txt /usr/share/doc/nyx/

FROM base AS monitor
ARG TARGETARCH
COPY dist/linux-${TARGETARCH}/nyx-monitor /usr/local/bin/
COPY dist/linux-${TARGETARCH}/nyx-notify /usr/local/bin/
COPY dist/linux-amd64/nyx-agent /usr/share/nyx/agents/nyx-agent-linux-x86_64
COPY dist/linux-arm64/nyx-agent /usr/share/nyx/agents/nyx-agent-linux-aarch64
USER nyx
EXPOSE 8081
ENTRYPOINT ["nyx-monitor"]

FROM base AS manager
ARG TARGETARCH
COPY dist/linux-${TARGETARCH}/nyx-manager /usr/local/bin/
COPY dist/linux-${TARGETARCH}/nyx-notify /usr/local/bin/
USER nyx
EXPOSE 8082
ENTRYPOINT ["nyx-manager"]

FROM base AS pocketbase
ARG TARGETARCH
COPY dist/linux-${TARGETARCH}/pocketbase /usr/local/bin/
COPY pb/pb_migrations /usr/share/nyx/pb_migrations
RUN install -d -o nyx /data
USER nyx
VOLUME /data
ENTRYPOINT ["pocketbase", "serve", "--http", "0.0.0.0:8090", "--dir", "/data", "--migrationsDir", "/usr/share/nyx/pb_migrations"]

# Runs as root with host namespaces: see docs/deployment.md.
FROM base AS agent
ARG TARGETARCH
RUN apk add --no-cache smartmontools
COPY dist/linux-${TARGETARCH}/nyx-agent /usr/local/bin/
ENTRYPOINT ["nyx-agent", "run"]
