# syntax=docker/dockerfile:1
# Image for the fcd server with the web client embedded.
# Build (from the repository root):
#   docker buildx build --platform linux/amd64 -t family-chat/fcd:latest --load .

# 1. Web client. Its output does not depend on the CPU, so it builds on the host platform.
FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm --filter @family-chat/web... build

# 2. Server. Built for the target platform; on alpine the default target is musl, so the binary is static.
FROM rust:1-alpine AS server
RUN apk add --no-cache musl-dev
WORKDIR /src/server
COPY server ./
COPY --from=web /src/apps/web/dist /src/apps/web/dist
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/server/target,sharing=locked \
    cargo build --release --locked \
    && cp target/release/fcd /fcd \
    && mkdir /data-empty

# 3. Runtime: the static binary only. Root certificates for Web Push are compiled into fcd.
FROM scratch
COPY --from=server /fcd /fcd
COPY --from=server --chown=65534:65534 /data-empty /data
USER 65534:65534
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["/fcd", "--data", "/data"]
