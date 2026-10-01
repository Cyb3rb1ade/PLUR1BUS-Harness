FROM rust:1.95-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1 AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY mock-harness/ mock-harness/
COPY test-bins/ test-bins/
COPY src-tauri/Cargo.toml src-tauri/Cargo.toml
COPY src-tauri/build.rs src-tauri/build.rs
COPY src-tauri/src/ src-tauri/src/
RUN cargo build --locked --release -p plur1bus-mock-harness -p plur1bus-desktop-test-bins

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN groupadd --gid 10001 plur1bus && useradd --uid 10001 --gid 10001 --home-dir /var/lib/plur1bus --create-home --shell /usr/sbin/nologin plur1bus
COPY --from=builder /build/target/release/plur1bus-mock-harness /usr/local/bin/plur1bus-mock-harness
COPY --from=builder /build/target/release/fake-plur1bus /usr/local/bin/plur1bus
USER 10001:10001
WORKDIR /var/lib/plur1bus
EXPOSE 18700
ENTRYPOINT ["/usr/local/bin/plur1bus-mock-harness", "--bind", "0.0.0.0", "--port", "18700", "--state-dir", "/var/lib/plur1bus"]
