# Google Chrome with hardware (VA-API) video decode on a headless Intel GPU.
#
# What is in here and why each piece is load-bearing:
#   google-chrome-stable          the browser under test (Chromium builds have no HEVC)
#   intel-media-va-driver-non-free, libva-drm2   the iHD VA-API driver Chrome dlopens
#   libpci3                       Chrome reads the GPU's PCI ids through it; without
#                                 it VA-API silently never initialises (README, trap 1)
#   libegl-mesa0, libgl1-mesa-dri, libgbm1   Mesa iris: EGL/GL for the GPU process
#   weston                        headless Wayland compositor; --headless Chrome cannot
#                                 present hardware frames (README, trap 2)
#   nodejs                        runs the DevTools driver (cdp.mjs), no npm packages
#   ffmpeg, vainfo                generate test clips, prove the driver decodes
FROM ubuntu:noble

ARG UID=1000
ARG GID=1000
# Override to pin a specific Chrome build; the default is whatever stable is today.
ARG CHROME_DEB_URL=https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates wget \
        intel-media-va-driver-non-free libva2 libva-drm2 vainfo libpci3 \
        libegl-mesa0 libgl1-mesa-dri libgbm1 mesa-vulkan-drivers libvulkan1 \
        weston libxkbcommon0 \
        nodejs ffmpeg fonts-liberation fontconfig \
        openssh-client curl \
    && wget -q -O /tmp/chrome.deb "$CHROME_DEB_URL" \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm -f /tmp/chrome.deb && rm -rf /var/lib/apt/lists/*

# Run as the invoking user so files written to the bind mount stay theirs.
RUN (getent group "$GID" >/dev/null || groupadd -g "$GID" qa) \
    && useradd -m -u "$UID" -g "$GID" -s /bin/bash qa

# iHD is the driver for Gen8+ Intel GPUs; pin it so libva never picks i965.
ENV LIBVA_DRIVER_NAME=iHD

COPY docker/entry.sh /opt/entry.sh
COPY docker/make-clips.sh /opt/make-clips.sh
COPY cdp.mjs /opt/cdp.mjs
COPY web/blank.html /opt/web/blank.html
COPY web/dc-probe.js /opt/web/dc-probe.js
RUN chmod +x /opt/entry.sh /opt/make-clips.sh

USER qa
WORKDIR /work
ENTRYPOINT ["/opt/entry.sh"]
