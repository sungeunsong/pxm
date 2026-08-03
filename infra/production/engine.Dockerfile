FROM rust:1.88-bookworm AS build
WORKDIR /src
COPY apps/engine/Cargo.toml apps/engine/Cargo.lock ./apps/engine/
COPY apps/engine/src ./apps/engine/src
RUN cargo build --release --locked --manifest-path apps/engine/Cargo.toml

FROM node:22-bookworm-slim AS runtime
ENV PXM_RUN_AS_UID=10001 PXM_RUN_AS_GID=10001
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 pxm \
  && useradd --uid 10001 --gid pxm --no-create-home --shell /usr/sbin/nologin pxm
WORKDIR /app
COPY --from=build /src/apps/engine/target/release/pxm-engine /usr/local/bin/pxm-engine
COPY apps/api/plugin-manifests ./plugin-manifests
COPY apps/api/plugin-controls.json ./plugin-controls.json
COPY infra/production/load-secrets.sh /usr/local/bin/pxm-load-secrets
RUN chmod 0555 /usr/local/bin/pxm-engine /usr/local/bin/pxm-load-secrets \
  && mkdir -p /app/logs \
  && chown -R pxm:pxm /app/logs
ENTRYPOINT ["/usr/local/bin/pxm-load-secrets"]
CMD ["/usr/local/bin/pxm-engine"]
