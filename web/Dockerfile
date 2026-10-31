# RoadMap Studio (web).
#
# Every external location is a build argument and the DEFAULTS ARE THE COMPANY
# LOCATIONS: a plain `docker build` at work pulls through registry.avro.com, fetches
# Go modules from the company Artifactory and goes out through the company
# proxy. home.env overrides them (`docker compose --env-file home.env ...`).
# Never edit this file per site. (avro.com stands for the company domain -
# put the real names in work.env and here when deploying.)
#
#   IMAGE_REGISTRY  prefix in front of Docker Hub paths          default registry.avro.com/
#   GOPROXY         Go module proxy                               default the company Artifactory go-public
#   HTTP_PROXY / HTTPS_PROXY / NO_PROXY                           default the company proxy, not for avro.com
#
# Digest pins are content-addressed, so the same digest resolves behind the
# mirror; only the path in front of it changes. A pin may only move to an image
# that was already 72 hours old (image-digests.json, asserted by deploy_test.go).
#
# Plain Dockerfile syntax only: the work build host has no buildx, so nothing
# BuildKit-only (no RUN --mount, no COPY --chmod, no heredocs).
ARG IMAGE_REGISTRY=registry.avro.com/
ARG IMAGE_GOLANG=golang:1.25-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437
ARG IMAGE_UBUNTU=ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac

# Stage 1: build the server, with the UI embedded in it.
FROM ${IMAGE_REGISTRY}${IMAGE_GOLANG} AS build
ARG GOPROXY=https://artifactory.avro.com/artifactory/api/go/go-public/
# The proxy, for any download that leaves the company network. Build
# arguments, not ENV, so they exist only while this stage runs; lowercase too,
# because many tools read only those.
ARG HTTP_PROXY=http://proxy.avro.com:8000
ARG HTTPS_PROXY=http://proxy.avro.com:8000
ARG NO_PROXY=localhost,127.0.0.1,.avro.com,avro.com
ARG http_proxy=${HTTP_PROXY}
ARG https_proxy=${HTTPS_PROXY}
ARG no_proxy=${NO_PROXY}
ARG APP_VERSION=2.0.0
# go.sum is committed and complete, and -mod=readonly refuses to change it, so
# every module is checked against those hashes; the public checksum database
# (sum.golang.org, unreachable from work) adds nothing here.
ENV GOPROXY=${GOPROXY} GOFLAGS=-mod=readonly GOSUMDB=off CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /src
COPY go.mod go.sum go-publish-times.json ./
COPY tools/agegate/ tools/agegate/
# Supply-chain rule: nothing published in the last 72 hours is built in. The
# gate reads only the committed cache (the work network cannot reach the
# public registries) and refuses any module it has no publish time for.
RUN go mod download && go run ./tools/agegate -check -hours 72
COPY *.go ./
COPY migrations/ migrations/
COPY ui/ ui/
RUN go build -trimpath -ldflags "-s -w -X main.appVersion=${APP_VERSION}" -o /out/roadmap .

# Stage 2: runtime - Ubuntu, one static binary, no shell needed by the app.
FROM ${IMAGE_REGISTRY}${IMAGE_UBUNTU}
ARG GOPROXY=https://artifactory.avro.com/artifactory/api/go/go-public/
ARG HTTP_PROXY=http://proxy.avro.com:8000
ARG HTTPS_PROXY=http://proxy.avro.com:8000
ARG NO_PROXY=localhost,127.0.0.1,.avro.com,avro.com
ARG http_proxy=${HTTP_PROXY}
ARG https_proxy=${HTTPS_PROXY}
ARG no_proxy=${NO_PROXY}
# Build-time only: the running image keeps none of them. The app's one
# outbound call (the identity provider metadata) uses RMS_OUTBOUND_PROXY.
# Kept on two flat lines: the corporate deployment audit greps for this shape.
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
