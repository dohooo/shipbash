# The pi SDK, the activity lane's engine, and every @earendil-works package it
# depends on, each pinned exactly. pi ships no shrinkwrap since 1.0.1, and its
# own ranges (^1.0.1) would let a later build take a newer pi-ai or
# pi-agent-core than the one this pin was checked with. The one list: both
# installs below (the type gate and the runtime) and both pi lanes
# (scripts/pi-packages.ts) read it from here, and control-plane and the
# console, where conversation turns run pi on the host, pin the same set in
# their package.json, which must stay equal to it. A pi upgrade updates every
# line.
ARG PI_PACKAGES="\
  @earendil-works/pi-coding-agent@1.0.1 \
  @earendil-works/chord@1.0.1 \
  @earendil-works/pi-agent-core@1.0.1 \
  @earendil-works/pi-ai@1.0.1 \
  @earendil-works/pi-codemode@1.0.1 \
  @earendil-works/pi-mcp@1.0.1 \
  @earendil-works/pi-telemetry@1.0.1 \
  @earendil-works/pi-tui@1.0.1"

FROM node:24-bookworm@sha256:392e1e23f34da768d8d1f4e502b64f200d3be3465934d4b7930f57d7e2fc1989 AS task-builder

# The repository installs and runs its scripts with Bun, the version the root
# package.json's packageManager names; the scripts themselves still run on
# this Node. The binary is the official image's, pinned by digest. A Bun
# upgrade moves these together: packageManager in the root package.json and
# the oven/bun image tag and digest here. Vercel installs with its own 1.4.x.
COPY --from=oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /build
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/control-plane/package.json ./packages/control-plane/package.json
COPY packages/runner/package.json ./packages/runner/package.json
RUN bun install --frozen-lockfile --ignore-scripts
COPY packages/contracts ./packages/contracts
COPY packages/control-plane ./packages/control-plane
COPY packages/runner ./packages/runner
# The pi-lane type gate runs here, beside the build the runtime bundle comes
# from, so a pi upgrade that changes the API surface fails THIS build, not
# the first run.
ARG PI_PACKAGES
RUN bun add --no-save --ignore-scripts ${PI_PACKAGES} \
    && bun x tsc -p packages/runner/tsconfig.pi.json --noEmit

RUN bun run --filter @shipbash/contracts build \
    && bun run --filter @shipbash/runner build \
    && bun run --filter @shipbash/control-plane build \
    && bun x esbuild packages/control-plane/dist/vercel-sandbox-task.js \
      --bundle \
      --platform=node \
      --format=esm \
      --outfile=/build/bundle/vercel-sandbox-task.js \
      --banner:js="import { createRequire as __shipbashCreateRequire } from 'node:module'; const require = __shipbashCreateRequire(import.meta.url);" \
    && node --input-type=module --eval "await import('/build/bundle/vercel-sandbox-task.js')"

# The runtime stage uses the slim variant: every binary the runner spawns
# (chromium, ffmpeg, Xvfb, x11vnc, websockify, openbox, wmctrl, git,
# agent-browser, node) is installed explicitly below, and the full
# bookworm toolchain (~1GB) pushed the image past the size Vercel's registry
# can process into a sandbox-ready state.
FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ARG TARGETARCH
ARG CHROMIUM_VERSION=154.0.8037.92-1~deb12u1

# Dependency spillover apt cannot decline: packages Debian declares as hard
# dependencies that nothing in this image ever loads. Each is removed with
# the dependency check forced off, in the same layer as the install (a later
# layer cannot shrink an earlier one), so this is the image's only apt layer.
#   libgl1-mesa-dri, libllvm15, libz3-4: Mesa's software GL, required by
#     chromium-common; Chromium here renders through its own ANGLE/SwiftShader
#     (DESKTOP_BROWSER_ARGS in desktop-browser.mjs) and headless never asks Mesa.
#     libdrm-amdgpu1, libdrm-nouveau2, libdrm-radeon1, libsensors5 and
#     libsensors-config are Mesa's own dependencies, which nothing else uses.
#   nodejs, libnode108, node-acorn: Debian's Node.js, pulled in by novnc for a
#     build-time tool; the image runs the official node at /usr/local/bin.
#   python3-numpy: websockify's optional accelerator; the pure-Python path
#     serves noVNC just as well.
#   adwaita-icon-theme: GTK's icon theme via chromium's GTK dependency; the
#     browser opens no GTK dialogs, and hicolor stays as the fallback.
#   libgs10, libspectre1, poppler-data: Ghostscript, reached only through
#     imlib2's PostScript loader under openbox, which never loads one.
#     libgs10-common, libijs-0.35, libjbig2dec0, libidn12 and libpaper1 are
#     Ghostscript's own dependencies, which nothing else uses.
# Chromium's Vulkan validation layer and mock driver are debugging aids no
# process loads; Chromium renders through the SwiftShader driver beside them.
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      "chromium=${CHROMIUM_VERSION}" \
      "chromium-common=${CHROMIUM_VERSION}" \
      "chromium-sandbox=${CHROMIUM_VERSION}" \
      curl \
      ffmpeg \
      fonts-dejavu-core \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      jq \
      libnss-wrapper \
      novnc \
      openbox \
      websockify \
      wmctrl \
      x11vnc \
      xvfb \
      git openssl unzip util-linux; \
    dpkg --purge --force-depends \
      libgl1-mesa-dri libllvm15 libz3-4 \
      libdrm-amdgpu1 libdrm-nouveau2 libdrm-radeon1 libsensors5 libsensors-config \
      nodejs libnode108 node-acorn \
      python3-numpy \
      adwaita-icon-theme \
      libgs10 libspectre1 poppler-data \
      libgs10-common libijs-0.35 libjbig2dec0 libidn12 libpaper1; \
    rm -f /usr/lib/chromium/libVkICD_mock_icd.so* /usr/lib/chromium/libVkLayer_khronos_validation.so*; \
    rm -rf /var/lib/apt/lists/*

# pnpm rides the image's global npm prefix, /usr/local (the agent's shell
# keeps its own under HOME, terminal-shell.mjs), so a product that declares
# it as its package manager finds it on PATH for any uid.
RUN npm install --global --omit=dev pnpm@12.3.4 \
    && npm cache clean --force

WORKDIR /shipbash
# The dispatch executor at /shipbash/dist is a self-contained esbuild bundle, so
# the runner needs no application node_modules. Six packages are installed:
# `ws` (imported by the stream bridge and browser stream proxy under
# /shipbash/runtime), `tldts` (the public suffix list behind the sign-in
# ruler in contracts/runtime/sign-in-scope.mjs), `@wterm/dom` with the
# `@wterm/core` it pins (the console's own terminal renderer, which the
# replay export loads into a headless page to draw shell segments,
# runtime/terminal-page.mjs), `@secretlint/core` with its
# recommended rules (what masks the sandbox shell's output,
# runtime/terminal-text-masking.mjs) and the pi SDK — the activity lane's engine
# — with the @earendil-works packages it depends on. Keep every version aligned
# with its other pin (ws, tldts, @wterm/dom, secretlint: bun.lock; pi:
# PI_PACKAGES, the list the type gate installs too). Source maps and type
# declarations are deleted (no process here enables source maps, and Node never
# loads a .d.ts) and the write bits are dropped in this same layer, so neither
# duplicates the content in a later one.
ARG PI_PACKAGES
RUN set -eux; \
    printf '{"name":"shipbash-runner","private":true,"type":"module"}\n' > /shipbash/package.json; \
    npm install --no-save --ignore-scripts --no-audit --no-fund ws@8.21.3 tldts@7.4.11 @wterm/dom@0.3.4 @secretlint/core@13.0.5 @secretlint/secretlint-rule-preset-recommend@13.0.5 ${PI_PACKAGES}; \
    npm cache clean --force; \
    find /shipbash/node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete; \
    mkdir -p /shipbash/node_modules/@shipbash/contracts/dist /shipbash/node_modules/zod; \
    chmod -R a-w /shipbash/node_modules /shipbash/package.json

RUN set -eux; \
    case "${TARGETARCH}" in \
      arm64) \
        artifact="agent-browser-linux-arm64"; \
        checksum="937b315ee0761e8a62f7950ddcfef9b3d3d8e8d5eb9c9d2bf9e23e5725664511" \
        ;; \
      amd64) \
        artifact="agent-browser-linux-x64"; \
        checksum="5100149a1903211c889de4e545bf36d90803740cea4f99aa22651649f9205ea1" \
        ;; \
      *) \
        echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; \
        exit 1 \
        ;; \
    esac; \
    curl --fail --location --retry 3 \
      "https://github.com/vercel-labs/agent-browser/releases/download/v0.38.1/${artifact}" \
      --output /usr/local/bin/agent-browser; \
    echo "${checksum}  /usr/local/bin/agent-browser" | sha256sum --check --strict; \
    chmod 0755 /usr/local/bin/agent-browser; \
    agent-browser --version; \
    ffmpeg -version; \
    ffprobe -version; \
    # Browser recordings are H.264 in MP4. Debian's ffmpeg is built
    # --enable-libx264, but a base image that quietly dropped it would
    # otherwise only show up as every recording failing to finalize.
    ffmpeg -hide_banner -encoders | grep -qw libx264; \
    pnpm --version

# bun, pinned the same way as agent-browser: the official release zip per
# TARGETARCH, checked against the SHASUMS256.txt of that release, and placed
# where every uid can run it. A product whose scaffold says `bun start` had
# no bun to start with (a target product). The x64 build wants AVX2; the
# baseline build exists for hosts without it.
RUN set -eux; \
    case "${TARGETARCH}" in \
      arm64) \
        artifact="bun-linux-aarch64"; \
        checksum="54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7" \
        ;; \
      amd64) \
        artifact="bun-linux-x64"; \
        checksum="36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913" \
        ;; \
      *) \
        echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; \
        exit 1 \
        ;; \
    esac; \
    curl --fail --location --retry 3 \
      "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/${artifact}.zip" \
      --output /tmp/bun.zip; \
    echo "${checksum}  /tmp/bun.zip" | sha256sum --check --strict; \
    unzip -q -j /tmp/bun.zip "${artifact}/bun" -d /usr/local/bin; \
    rm /tmp/bun.zip; \
    chmod 0755 /usr/local/bin/bun; \
    bun --version

RUN set -eux; \
    groupadd --gid 10001 shipbash; \
    useradd --uid 10001 --gid 10001 --create-home --home-dir /shipbash/home shipbash; \
    mkdir -p \
      /shipbash/control \
      /shipbash/control/auth \
      /shipbash/dist \
      /shipbash/input \
      /shipbash/output \
      /shipbash/repositories \
      /shipbash/runtime \
      /shipbash/tasks \
      /shipbash/work \
      /run/agent-browser; \
    ln -s /shipbash/control/auth /shipbash/auth; \
    chown -R shipbash:shipbash \
      /shipbash/control \
      /shipbash/home \
      /shipbash/input \
      /shipbash/output \
      /shipbash/work \
      /run/agent-browser

# The shipbash user above, which a Sandbox runs the agent as (root runs the
# dispatch), must have no way to root: /etc/passwd stays root's to write, and
# no program runs setuid root but Chromium's sandbox helper. A writable passwd
# and a setuid su made it root in one line. Local Docker runs the runner as
# the host's uid, which passwd does not list; the runner names it through
# nss_wrapper (runtime/uid-name.mjs).
RUN find / -xdev -type f -perm -4000 ! -path /usr/lib/chromium/chrome-sandbox -exec chmod u-s {} +
# Chromium's password manager is off for every browser this image starts —
# the agent's, whose Playwright contexts have no profile to seed, and the
# takeover viewer's alike — so no "Save password?" bubble ever covers a
# sign-in. A managed policy is the one switch that reaches every profile and
# every off-the-record context (Chromium 154 reports it on chrome://policy as
# Platform / Machine / Mandatory / OK).
RUN mkdir -p /etc/chromium/policies/managed \
    && printf '%s\n' '{"PasswordManagerEnabled": false}' > /etc/chromium/policies/managed/shipbash.json
ENV NODE_ENV=production \
    HOME=/shipbash/home \
    CHROME_BIN=/usr/bin/chromium \
    AGENT_BROWSER_SOCKET_DIR=/run/agent-browser \
    AGENT_BROWSER_NAMESPACE=browser-idle \
    AGENT_BROWSER_SESSION=browser-idle \
    AGENT_BROWSER_CONTENT_BOUNDARIES=true \
    AGENT_BROWSER_MAX_OUTPUT=20000

COPY packages/runner/scripts/patch-novnc-first-frame.mjs /tmp/patch-novnc-first-frame.mjs
RUN test "$(dpkg-query -W -f='${Version}' novnc)" = '1:1.3.0-1' \
    && node /tmp/patch-novnc-first-frame.mjs /usr/share/novnc \
    && rm /tmp/patch-novnc-first-frame.mjs
COPY packages/runner/src/runtime/novnc-clipboard-core.js /usr/share/novnc/app/shipbash-clipboard-core.js
COPY packages/runner/src/runtime/novnc-control-core.js /usr/share/novnc/app/shipbash-control-core.js
COPY packages/runner/src/runtime/novnc-clipboard.js /usr/share/novnc/app/shipbash-clipboard.js
RUN set -eux; \
    grep -q 'src="app/ui.js"' /usr/share/novnc/vnc.html; \
    sed -i '\#src="app/ui.js"#a\    <script type="module" crossorigin="anonymous" src="app/shipbash-clipboard.js"></script>' /usr/share/novnc/vnc.html; \
    grep -q 'src="app/shipbash-clipboard.js"' /usr/share/novnc/vnc.html

# Runner sources import shared contracts by package name in the repository and
# in the image. Installing the built private workspace here keeps those imports
# stable without changing the long-lived /shipbash runtime ABI. It lands without
# write bits, like the rest of node_modules: a COPY's --chmod covers what it
# copies but not a destination directory it creates, so the install's RUN
# creates dist and zod beforehand. It sits among the source copies because
# every release changes it (its version), and a changed layer rebuilds every
# layer after it.
COPY --from=task-builder --chmod=a-w /build/packages/contracts/package.json /shipbash/node_modules/@shipbash/contracts/package.json
COPY --from=task-builder --chmod=a-w /build/packages/contracts/dist /shipbash/node_modules/@shipbash/contracts/dist
COPY --from=task-builder --chmod=a-w /build/node_modules/zod /shipbash/node_modules/zod

# Keep the container-owned runtime flat at its established absolute path. The
# source package is nested only in the repository; no /shipbash caller changes.
# 0555, not 0444: --chmod applies to the copied DIRECTORIES too, and a
# directory without its execute bit cannot be traversed by the non-root uid
# the dispatch runs as — Node then reports every module inside it as not
# found. Files gain a harmless execute bit and stay unwritable.
COPY --chmod=0555 packages/runner/src/runtime /shipbash/runtime
COPY --chmod=0444 packages/contracts/src/runtime/activity-output.schema.json /shipbash/runtime/activity-output.schema.json
COPY --chmod=0444 packages/contracts/src/runtime/case-output.schema.json /shipbash/runtime/case-output.schema.json
COPY --chmod=0444 packages/contracts/src/runtime/code-evidence-output.schema.json /shipbash/runtime/code-evidence-output.schema.json
COPY --from=task-builder --chmod=0555 /build/bundle /shipbash/dist

# The pi surface the activity lane depends on must exist in the pinned SDK;
# a rename fails the build here instead of the first live run.
RUN node /shipbash/runtime/pi-smoke.mjs \
    && node --input-type=module --eval "await import('/shipbash/runtime/suite-runner.mjs'); await import('/shipbash/runtime/activity-runner.mjs'); await import('/shipbash/runtime/pi-agent.mjs')"

# Where Codex reads its system configuration layer. The gateway is the
# deployment's, so the file itself is placed when a runner starts: a local
# container mounts it, a Sandbox's dispatch writes it (codex-config.mjs).
RUN mkdir -p /etc/codex

USER root:root
WORKDIR /shipbash/work
STOPSIGNAL SIGTERM

ENTRYPOINT ["node", "/shipbash/runtime/vercel-dispatch-runner.mjs"]

# Last, after every RUN: a build arg is in the environment of each RUN that
# follows it, so its value is part of their cache keys, and this one changes
# with every source edit and every release.
ARG SHIPBASH_RUNNER_BUILD_DIGEST=unknown
LABEL io.shipbash.runner.build-digest="${SHIPBASH_RUNNER_BUILD_DIGEST}"
