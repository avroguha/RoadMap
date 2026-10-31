# RoadMap Studio (web).
#
# Every external location is a build argument with a public default, so a plain
# `docker build` works anywhere with internet access. A site with its own
# registry mirror, Go module proxy or outbound proxy sets them in the env file
# (`docker compose --env-file deploy.env ...`). Never edit this file per site.
#
#   IMAGE_REGISTRY  prefix in front of Docker Hub paths (e.g. mirror.example.com/)   default none
#   GOPROXY         Go module proxy                                                  default proxy.golang.org
#   HTTP_PROXY / HTTPS_PROXY / NO_PROXY                                              default none
#
# Digest pins are content-addressed, so the same digest resolves behind a
# mirror; only the path in front of it changes. A pin may only move to an image
# that was already 72 hours old (image-digests.json, asserted by deploy_test.go).
#
# Plain Dockerfile syntax only, so it builds on the legacy builder as well as
# BuildKit: nothing BuildKit-only (no RUN --mount, no COPY --chmod, no heredocs).
ARG IMAGE_REGISTRY=
ARG IMAGE_GOLANG=golang:1.25-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437
ARG IMAGE_UBUNTU=ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac

# Stage 1: build the server, with the UI embedded in it.
FROM ${IMAGE_REGISTRY}${IMAGE_GOLANG} AS build
ARG GOPROXY=https://proxy.golang.org,direct
# An outbound proxy, for sites that need one. Build arguments, not ENV, so
# they exist only while this stage runs; lowercase too, because many tools
# read only those.
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ARG NO_PROXY=localhost,127.0.0.1
ARG http_proxy=${HTTP_PROXY}
ARG https_proxy=${HTTPS_PROXY}
ARG no_proxy=${NO_PROXY}
ARG APP_VERSION=2.0.0
# go.sum is committed and complete, and -mod=readonly refuses to change it, so
# every module is checked against those hashes; the public checksum database
# adds nothing here, and a build host that cannot reach it still builds.
ENV GOPROXY=${GOPROXY} GOFLAGS=-mod=readonly GOSUMDB=off CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /src
COPY go.mod go.sum go-publish-times.json ./
COPY tools/agegate/ tools/agegate/
# Supply-chain rule: nothing published in the last 72 hours is built in. The
# gate reads only the committed cache (so it needs no network, and gives the
# same answer everywhere) and refuses any module it has no publish time for.
RUN go mod download && go run ./tools/agegate -check -hours 72
COPY *.go ./
COPY migrations/ migrations/
COPY ui/ ui/
RUN go build -trimpath -ldflags "-s -w -X main.appVersion=${APP_VERSION}" -o /out/roadmap .

# Stage 2: runtime - Ubuntu, one static binary, no shell needed by the app.
FROM ${IMAGE_REGISTRY}${IMAGE_UBUNTU}
ARG GOPROXY=https://proxy.golang.org,direct
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ARG NO_PROXY=localhost,127.0.0.1
ARG http_proxy=${HTTP_PROXY}
ARG https_proxy=${HTTPS_PROXY}
ARG no_proxy=${NO_PROXY}
# Build-time only: the running image keeps none of them. The app's one
# outbound call (the identity provider metadata) uses RMS_OUTBOUND_PROXY.
# Kept on two flat lines: deploy_test.go looks for exactly this shape.
ENV GOPROXY= HTTP_PROXY= HTTPS_PROXY= NO_PROXY=
ENV http_proxy= https_proxy= no_proxy=
# Ubuntu 24.04 ships a user `ubuntu` holding uid 1000; free it first.
RUN userdel -r ubuntu 2>/dev/null || true; \
    groupadd -g 1000 roadmap && useradd -u 1000 -g 1000 -M -d /nonexistent -s /usr/sbin/nologin roadmap && \
    mkdir -p /certs /credentials && chown 1000:1000 /certs /credentials
# The CA bundle for the metadata fetch over HTTPS (Ubuntu's base image has
# none; a proxy that re-signs TLS adds its CA as /certs/ca.crt instead).
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/roadmap /usr/local/bin/roadmap
USER 1000:1000
ENV RMS_LISTEN=:8443 \
    RMS_REDIRECT_LISTEN=:8080 \
    RMS_HEALTH_LISTEN=127.0.0.1:8079 \
    RMS_TLS_DIR=/certs
EXPOSE 8443 8080
# The app's own binary answers the health check: no language runtime is started.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["/usr/local/bin/roadmap", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/roadmap"]
CMD ["serve"]
