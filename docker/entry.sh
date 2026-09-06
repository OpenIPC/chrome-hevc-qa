#!/bin/bash
# Container entrypoint.
#
#   entry.sh chrome <task> [task args] [-- <extra chrome flags>]
#       start a headless Weston on the GPU, run the DevTools driver against a
#       full (non-headless) Chrome on that Wayland display.
#   entry.sh <anything else>
#       run it as-is (bash, vainfo, ffmpeg, make-clips.sh ...).
set -u

if [ "${1:-}" != "chrome" ]; then
    exec "$@"
fi
shift

export XDG_RUNTIME_DIR=/tmp/xdg-$$
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
export WAYLAND_DISPLAY=wayland-0
export HOME=${HOME:-/tmp/home}
mkdir -p "$HOME"

# The GL renderer is what makes Weston sit on the real GPU (EGL surfaceless on
# the render node) and advertise dma-buf import, which is what Chrome's
# decoded frames arrive as. --renderer=pixman would silently take that away.
weston --backend=headless --renderer=gl \
       --width="${WESTON_WIDTH:-1920}" --height="${WESTON_HEIGHT:-1080}" \
       --idle-time=0 --no-config --socket="$WAYLAND_DISPLAY" \
       --log=/tmp/weston.log >/dev/null 2>&1 &
weston_pid=$!

for _ in $(seq 1 100); do
    [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && break
    sleep 0.1
done
if [ ! -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]; then
    echo "weston did not come up:" >&2
    cat /tmp/weston.log >&2
    exit 2
fi
if ! grep -q 'GL renderer: Mesa Intel' /tmp/weston.log; then
    echo "WARNING: weston is not rendering on the Intel GPU; Chrome will not get hardware decode:" >&2
    grep -E 'renderer|EGL|GL' /tmp/weston.log >&2
fi
[ -n "${HEVC_VERBOSE:-}" ] && grep -E 'GL renderer|dmabuf' /tmp/weston.log >&2

# Everything after "--" is passed to Chrome verbatim; the two flags below are
# what every run needs on this platform, so they are added to every call.
has_sep=0
for a in "$@"; do [ "$a" = "--" ] && has_sep=1; done
[ $has_sep -eq 1 ] || set -- "$@" --
node /opt/cdp.mjs /opt/google/chrome/chrome "$@" \
     --ozone-platform=wayland --ignore-gpu-blocklist
rc=$?
kill "$weston_pid" 2>/dev/null
exit $rc
