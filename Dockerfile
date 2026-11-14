# syntax=docker/dockerfile:1
# Image of the fcd server with the web client built in.
#
# Build (from the repository root):
#   docker buildx build --platform linux/amd64 -t fcd:dev --load .
#   docker buildx build --platform linux/amd64,linux/arm64,linux/arm/v7 -t <registry>/fcd:<version> --push .
#
# Every stage that compiles runs on the build machine's own platform
# ($BUILDPLATFORM): the web client does not depend on the CPU, and the server
# is cross-compiled to the target platform with tonistiigi/xx (clang, lld and
# the target's musl from Alpine), so no slow CPU emulation is involved. The
# result is a static musl binary in an empty (scratch) image.
#
# Build arguments (all optional): FCD_VERSION and FCD_GIT_COMMIT for the
# labels and `fcd --version` (.git is not sent to the build), SOURCE_URL for
# the org.opencontainers.image.source label.

ARG RUST_VERSION=1
ARG NODE_VERSION=22
ARG XX_VERSION=1.6.1

FROM --platform=$BUILDPLATFORM tonistiigi/xx:${XX_VERSION} AS xx

# 1. Web client.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@family-chat/web..."
ARG FCD_GIT_COMMIT=""
ENV FCD_GIT_COMMIT=${FCD_GIT_COMMIT}
RUN pnpm --filter "@family-chat/web..." build

# 2. Server, cross-compiled for the target platform.
FROM --platform=$BUILDPLATFORM rust:${RUST_VERSION}-alpine AS server
COPY --from=xx / /
RUN apk add --no-cache clang lld musl-dev
ARG TARGETPLATFORM
RUN xx-apk add --no-cache musl-dev gcc
WORKDIR /src/server
COPY server ./
COPY --from=web /src/apps/web/dist /src/apps/web/dist
ARG FCD_GIT_COMMIT=""
ENV FCD_GIT_COMMIT=${FCD_GIT_COMMIT}
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/server/target,id=fcd-target-${TARGETPLATFORM},sharing=locked \
    xx-cargo build --release --locked --target-dir target \
    && cp "target/$(xx-cargo --print-target-triple)/release/fcd" /fcd \
    && xx-verify --static /fcd \
    && mkdir /data-empty

# 3. Runtime: the static binary only. Root certificates for Web Push are
# compiled into fcd; there is no shell, so the health check is fcd itself.
FROM scratch
ARG FCD_VERSION=dev
ARG FCD_GIT_COMMIT=""
ARG SOURCE_URL=""
LABEL org.opencontainers.image.title="fcd" \
      org.opencontainers.image.description="Family Chat server: end-to-end encrypted family chat with the web client built in" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${FCD_VERSION}" \
      org.opencontainers.image.revision="${FCD_GIT_COMMIT}" \
      org.opencontainers.image.source="${SOURCE_URL}"
COPY --from=server /fcd /fcd
COPY --from=server --chown=65534:65534 /data-empty /data
USER 65534:65534
VOLUME /data
EXPOSE 8787
# Reads the port from /data/config.toml. If you change the port with a flag
# instead, pass the same flag here: fcd healthcheck --data /data --port <port>.
HEALTHCHECK --interval=30s --timeout=15s --start-period=10s --retries=3 \
    CMD ["/fcd", "healthcheck", "--data", "/data"]
ENTRYPOINT ["/fcd", "--data", "/data"]
