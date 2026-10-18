# syntax=docker/dockerfile:1
#
# JupyterLab with cdp-kernel, a kernelspec for every runtime, and the
# example notebooks: a way to try the kernel without installing it (#266).
# Build from the repository root:
#
#   docker build -f container/Dockerfile -t cdp-kernel .
#   docker run --rm -p 8888:8888 cdp-kernel
#
# By default the kernel is the npm release whose version is in the
# checkout's package.json, so an image built from a release tag matches
# what's on npm. --build-arg CDPK_SOURCE=checkout packs the checkout
# instead (CI on pull requests, the devcontainer).
#
# The runtime versions are the ones CI tests (ci.yml, docs/install.md).

ARG CDPK_SOURCE=npm
ARG BASE_IMAGE=quay.io/jupyter/minimal-notebook:2026-10-12
ARG NODE_VERSION=26
ARG DENO_VERSION=2.9.7
ARG BUN_VERSION=1.4.3
ARG WORKERD_VERSION=1.20261015.1
ARG CELLD_VERSION=0.6.2
ARG ANYWIDGET_VERSION=0.11.0

FROM node:${NODE_VERSION}-trixie-slim AS node
FROM denoland/deno:bin-${DENO_VERSION} AS deno
FROM oven/bun:${BUN_VERSION}-debian AS bun

# The package tarball, from npm or from the checkout. Only the stage that
# CDPK_SOURCE names is built.
FROM node AS package-npm
WORKDIR /pkg
COPY package.json /tmp/
RUN npm pack --silent "@tlockney/cdp-kernel@$(node -p 'require("/tmp/package.json").version')"

FROM node AS package-checkout
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN mkdir /pkg && npm pack --silent --pack-destination /pkg

FROM package-${CDPK_SOURCE} AS package

FROM ${BASE_IMAGE}
ARG WORKERD_VERSION
ARG CELLD_VERSION
ARG ANYWIDGET_VERSION
ARG TARGETARCH
USER root

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=deno /deno /usr/local/bin/deno
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# celld isn't on npm. The kernel finds it on PATH as well as in
# ~/.local/bin, where its installer puts it.
RUN case "$TARGETARCH" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=aarch64 ;; \
      *) echo "no celld build for $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/denoland/celld/releases/download/v${CELLD_VERSION}/celld-${arch}-unknown-linux-gnu.gz" \
    | gunzip > /usr/local/bin/celld \
 && chmod +x /usr/local/bin/celld

# A workerd target uses the workerd on PATH when the notebook's directory
# has no node_modules of its own. HOME is still jovyan's, so npm's cache
# goes elsewhere: a root-owned ~/.npm would break `npm:` imports.
RUN --mount=from=package,source=/pkg,target=/pkg \
    npm_config_cache=/tmp/npm-cache npm_config_update_notifier=false \
    npm install -g --no-audit --no-fund /pkg/*.tgz "workerd@${WORKERD_VERSION}" \
 && rm -rf /tmp/npm-cache

# Kernelspecs go in a system data directory rather than the home
# directory, so a volume mounted over /home/jovyan doesn't hide them.
RUN export JUPYTER_DATA_DIR=/usr/local/share/jupyter \
 && for runtime in node deno bun workerd celld; do \
      cdp-kernel install --runtime "$runtime"; \
    done \
 && cdp-kernel install --runtime node --deno-compat

# Widgets need anywidget's JupyterLab extension (docs/widgets.md).
RUN pip install --no-cache-dir "anywidget==${ANYWIDGET_VERSION}" \
 && fix-permissions "$CONDA_DIR"

USER ${NB_UID}
COPY --chown=${NB_UID}:${NB_GID} examples/*.ipynb docs/public/notebooks/ /home/${NB_USER}/examples/
WORKDIR /home/${NB_USER}/examples
