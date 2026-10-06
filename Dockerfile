# syntax=docker/dockerfile:1.7
#
# plur1bus-harness (M8, desktop D1 / spec §6.15): supervisor + core + the Rust CLI in one hardened image.
#
#   docker buildx build --secret id=engine_token,env=GH_ENGINE_READ_TOKEN -t plur1bus-harness .
#
# The engine (@cyb3rb1ade/plur1bus-memory) is a pinned git dependency; when its repository is private the build needs
# the read token as the BuildKit secret `engine_token`. It is mounted for the two RUNs that fetch dependencies only: it is
# never an ARG or ENV, never copied, never written into a layer. See docs/container.md.
#
# Base images are pinned by digest (glibc: LanceDB and onnxruntime prebuilds, spec §6.15.9). To bump one, resolve the
# digest of the multi-arch index (`docker buildx imagetools inspect <tag>`) and change tag and digest together.

# ---- 1. the Rust CLI and supervisor ----------------------------------------------------------------------------------
FROM rust:1.95-slim-bookworm@sha256:d7482085ff5b415f84dba5647ae71606650bdef00db7aeb69f4b3d170c3e4082 AS rust-build
WORKDIR /src
COPY . .
# The image's own toolchain (the digest above) is the pin; rust-toolchain.toml would make rustup resolve "1.95" again
# and download it under another name.
RUN rm -f rust-toolchain.toml
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --release --locked -p plur1bus \
    && install -D -m 0755 target/release/plur1bus /out/plur1bus

# ---- 2. the core: build, then `pnpm deploy` a self-contained production tree -----------------------------------------
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS node-build
ENV CI=true GIT_TERMINAL_PROMPT=0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-fund --no-audit pnpm@10.28.0
WORKDIR /src
COPY . .
# The lockfile records the engine's git repository as git@github.com:...; fetch it over https, with the read token when a
# secret is supplied. The token reaches git only through this RUN's environment.
RUN --mount=type=secret,id=engine_token,required=false \
    --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    set -eu; \
    base="https://github.com/"; \
    if [ -s /run/secrets/engine_token ]; then base="https://x-access-token:$(cat /run/secrets/engine_token)@github.com/"; fi; \
    export GIT_CONFIG_COUNT=3 \
      GIT_CONFIG_KEY_0="url.${base}.insteadOf" GIT_CONFIG_VALUE_0="https://github.com/" \
      GIT_CONFIG_KEY_1="url.${base}.insteadOf" GIT_CONFIG_VALUE_1="git@github.com:" \
      GIT_CONFIG_KEY_2="url.${base}.insteadOf" GIT_CONFIG_VALUE_2="ssh://git@github.com/"; \
    pnpm install --frozen-lockfile --filter "@plur1bus/core..." \
    && pnpm --filter "@plur1bus/core..." --if-present run gen \
    && pnpm --filter "@plur1bus/core..." run build
RUN --mount=type=secret,id=engine_token,required=false \
    --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    set -eu; \
    base="https://github.com/"; \
    if [ -s /run/secrets/engine_token ]; then base="https://x-access-token:$(cat /run/secrets/engine_token)@github.com/"; fi; \
    export GIT_CONFIG_COUNT=3 \
      GIT_CONFIG_KEY_0="url.${base}.insteadOf" GIT_CONFIG_VALUE_0="https://github.com/" \
      GIT_CONFIG_KEY_1="url.${base}.insteadOf" GIT_CONFIG_VALUE_1="git@github.com:" \
      GIT_CONFIG_KEY_2="url.${base}.insteadOf" GIT_CONFIG_VALUE_2="ssh://git@github.com/"; \
    pnpm --filter @plur1bus/core deploy --legacy --prod --config.node-linker=hoisted /out/core \
    && test -f /out/core/dist/core.js \
    && test -f /out/core/dist/import.js \
    && cd /out/core \
    && node --input-type=module -e "for (const m of ['@plur1bus/module-api','@plur1bus/rpc-schema','@plur1bus/config-schema']) await import(m)" \
    && rm -rf /out/core/src /out/core/test

# ---- 3. runtime ------------------------------------------------------------------------------------------------------
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
# The image runs the core and nothing installs packages at run time: no npm, corepack or yarn.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && groupadd --system --gid 10001 plur1bus \
    && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /var/lib/plur1bus --shell /usr/sbin/nologin plur1bus \
    && install -d -o 10001 -g 10001 -m 0700 /var/lib/plur1bus /var/lib/plur1bus/models
COPY --from=rust-build /out/plur1bus /usr/local/bin/plur1bus
COPY --from=node-build /out/core /opt/plur1bus/core
COPY deploy/container/healthcheck.mjs /opt/plur1bus/healthcheck.mjs
ENV PLUR1BUS_CONTAINER=1 \
    PLUR1BUS_HOME=/var/lib/plur1bus \
    PLUR1BUS_CORE_JS=/opt/plur1bus/core/dist/core.js \
    PLUR1BUS_NODE=/usr/local/bin/node \
    NODE_ENV=production \
    TMPDIR=/tmp
# State (config, stores, LanceDB, run files, logs, installed modules) and the model cache live on volumes; the root file
# system can be read-only (docker run --read-only --tmpfs /tmp).
VOLUME ["/var/lib/plur1bus", "/var/lib/plur1bus/models"]
USER 10001:10001
WORKDIR /var/lib/plur1bus
# Healthy when the supervisor answers and its core child is `ready`; the first start loads the engine, hence the grace.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD ["node", "/opt/plur1bus/healthcheck.mjs"]
STOPSIGNAL SIGTERM
LABEL org.opencontainers.image.title="plur1bus-harness" \
      org.opencontainers.image.description="PLUR1BUS harness: supervisor, core and CLI" \
      org.opencontainers.image.source="https://github.com/Cyb3rb1ade/PLUR1BUS-Harness"
ENTRYPOINT ["plur1bus", "supervise"]
