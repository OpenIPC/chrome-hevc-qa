# chrome-hevc-qa

Google Chrome with **hardware H.265 (HEVC) decode on a headless Linux server**,
packaged as a Docker image with a pass/fail test driver. Built for QA tasks
that need a real browser to prove an HEVC stream plays: `<video>` files, MSE,
and WebRTC H.265 receive from a camera.

Chrome has no software HEVC decoder. On Linux it decodes HEVC only through
VA-API on a GPU, and only when the whole chain from the render node to the
compositor is in place. This project is that chain, with every trap that
breaks it written down.

Measured baseline (2026-09-06): Chrome 152.0.7977.82 on an Intel UHD 770
(i9-13900, Raptor Lake-S), iHD driver 24.1.0, Mesa 25.2, Weston 13, kernel
7.0, Ubuntu 26.04 host. A 4K HEVC clip decodes 33 frames with 0 dropped in
1.5 s; a live WebRTC H.265 2592x1520 stream from a hi3516ev300 camera plays
at 24 fps with 0 dropped.

## Requirements

- Linux host with Docker.
- An Intel GPU with VA-API decode (Gen8 and newer; tested on Raptor Lake-S),
  bound to `i915` or `xe`, exposing `/dev/dri/renderD128`. AMD with
  `mesa-va-drivers` should work with a Dockerfile change but is untested.
  NVIDIA is out: Chrome disables VA-API on NVIDIA by default.
- Permission to pass the device through: `docker run --device /dev/dri`. The
  host user does not need to be in the `render` group; the runner adds the
  group id inside the container.
- No display, no X, no Wayland session on the host. Nothing is installed on
  the host.

## Quick start

```sh
git clone https://github.com/OpenIPC/chrome-hevc-qa.git && cd chrome-hevc-qa
./hevc-chrome build        # ~3 min: downloads the current Chrome stable deb
./hevc-chrome selfcheck    # VA-API profiles, Chrome codec probes, 4K HEVC playback
```

`selfcheck` ends with `SELFCHECK PASS` and exit code 0 when the GPU, the
driver and Chrome all agree. Its three stages are the three places the chain
breaks, in order, so a failure names the stage.

## Commands

| command | what it does |
| --- | --- |
| `./hevc-chrome build` | build the image as your uid/gid. `CHROME_DEB_URL=...` pins a specific Chrome deb. |
| `./hevc-chrome vainfo` | the VA-API profiles the GPU driver exposes (look for `VAProfileHEVCMain : VAEntrypointVLD`) |
| `./hevc-chrome clips` | generate `clips/`: `hevc_1080p`, `hevc_4k`, `hevc_main10` and the `h264_1080p` control |
| `./hevc-chrome sysinfo` | Chrome's own view of the GPU: PCI ids, feature status, ANGLE backend, VA-API log lines |
| `./hevc-chrome caps` | codec support table (`canPlayType`, MSE, mediaCapabilities, WebRTC receive/send); fails unless HEVC Main is supported |
| `./hevc-chrome shot <url> <out.png> [waitMs] [selector]` | sign in, load the page, wait, save a PNG into `shots/`; with a CSS selector the image is clipped to that element. For the pages whose verdict is what they look like — a lane, a chart, a layout — rather than something they can state |
| `./hevc-chrome play <clip\|url> [offscreen]` | play a video, report decoded size, frames decoded and dropped; fails on a media error or under `MIN_FRAMES` (default 10) |
| `./hevc-chrome preview <url> [waitMs] [clickSelector] [expectCodec]` | load a page that opens its own WebRTC session, report what it negotiated and decoded |
| `./hevc-chrome live <url> [waitMs] [transport] [stream]` | load the WebUI Live page over MSE (or WebRTC), sample every socket and the visible `<video>` once a second; fails on >1 `/ws/video` session per tab or on repeated MediaSource rebuilds (init re-emit thrash) |
| `./hevc-chrome dc <url> [seconds] [stream] [mode]` | the camera's video bitstream over an `RTCDataChannel`: offer a data-only PeerConnection on the camera's WebRTC signalling socket, check every message against the published header, ask for a keyframe halfway; mode `negotiated` (default), `dcep` (in-band open) or `mixed` (a video track beside the channel) |
| `./hevc-chrome bench <url> [seconds] [feed] [stream] [decoder]` | one measured Live-page run over the buffered transport (MSE, or the software rung with `decoder=wasm`), the bytes carried by `feed=datachannel` or `websocket`: capture-to-arrival lag percentiles from the fragments' producer reference times, frame rate, drops, gaps, stalls, bit rate, round trip, as JSON; fails unless the requested feed and decoder held every tick with the tab visible (`BENCH_WARMUP_S`, `BENCH_LABEL`, `BENCH_ICE`; `BENCH_SAMPLES=1` keeps the per-second samples in the JSON) |
| `./hevc-chrome selfcheck` | `vainfo` + `caps` + `play hevc_4k.mp4` |
| `./hevc-chrome tunnel <camera> [port]` / `untunnel [port]` | ssh port forward to a camera's web port when the container has no route to it (see below) |
| `./hevc-chrome shell` | bash inside the container with the GPU attached |

Anything after `--` is passed to Chrome verbatim, e.g.
`./hevc-chrome play hevc_4k.mp4 -- --vmodule='*vaapi*=4'`.

`CAMERA_USER` / `CAMERA_PASS` sign in to the camera's web interface before
`play` or `preview` loads an http(s) URL from it.

Exit codes for `sysinfo`, `caps`, `play`, `preview`: 0 pass, 1 the check
failed, 2 the harness itself broke (Chrome did not start, page never loaded).
Each prints its JSON, then one `PASS:` or `FAIL:` line, then the relevant
Chrome stderr lines. `CDP_ALL_STDERR=1` prints all of Chrome's stderr.

### What a pass looks like

```
$ ./hevc-chrome caps
H.264 High        canPlayType="probably"  MSE=true  mediaCapabilities=supported,powerEfficient,smooth
HEVC Main L4.1    canPlayType="probably"  MSE=true  mediaCapabilities=supported,powerEfficient,smooth
HEVC Main L5.1    canPlayType="probably"  MSE=true  mediaCapabilities=supported,powerEfficient,smooth
HEVC Main hev1    canPlayType="probably"  MSE=true  mediaCapabilities=supported,powerEfficient,smooth
HEVC Main10       canPlayType="probably"  MSE=true  mediaCapabilities=supported,powerEfficient,smooth
AV1 Main          canPlayType="probably"  MSE=true  mediaCapabilities=supported,powerEfficient,smooth
WebRTC receive video codecs: video/VP8, video/rtx, video/VP9, video/H264, video/AV1, video/H265, ...
WebRTC receive H265 lines: video/H265 level-id=186;profile-id=1;tier-flag=0;tx-mode=SRST | video/H265 level-id=186;profile-id=2;...
WebRTC send H265 lines: (none)
PASS: HEVC Main supported
```

Without a working hardware decoder the same Chrome answers `canPlayType=""`
and `MSE=false` for every HEVC row and lists no `video/H265` receive codec.
That is the whole test: HEVC support appearing at all means the GPU path is
alive.

```
$ ./hevc-chrome play hevc_4k.mp4
{ "videoWidth": 3840, "videoHeight": 2160, "totalVideoFrames": 33, "droppedVideoFrames": 0, "error": null, ... }
PASS: 33 frames at 3840x2160
```

## Testing a camera over WebRTC

The `preview` task drives any page that creates an `RTCPeerConnection`. It
hooks the constructor before the page's scripts run, waits, optionally clicks
an element (to switch streams), then reads `getStats()`: negotiated codec,
frames decoded and dropped, frame size, ICE state, plus the offer's codec list
and the answer's video lines.

For an OpenIPC camera running majestic:

```sh
CAMERA_USER=root CAMERA_PASS='...' \
./hevc-chrome preview http://<camera>/cgi-bin/preview.cgi 15000 '#mj-stream-0' H265
```

- The camera's web interface has a sign-in page and a session cookie. With
  `CAMERA_USER` and `CAMERA_PASS` set, the driver opens the sign-in page and
  posts the same request the page's own form sends, so Chrome stores the
  session cookie exactly as it would for a person; the page, every fetch it
  makes and the WebSocket signalling channel then carry it. A refused
  sign-in fails the run at once (`FAIL: sign-in refused (HTTP 403)`), and the
  password is never part of a page URL. The same variables work for `play`
  with an http(s) URL served by the camera, for example a recording.
- The WebUI preview opens on the **sub stream** unless the browser has a
  remembered choice. `#mj-stream-0` is the Main radio; clicking it makes the
  page renegotiate on stream 0. The `H265` argument makes the run fail unless
  the decoded codec is H.265, so a silent fallback to H.264 is caught.
- If the container has no route to the camera (a lab that is only reachable
  over ssh), `./hevc-chrome tunnel <camera>` forwards host port 18080 to the
  camera's web port over ssh and prints the address to use inside the
  container (`http://172.17.0.1:18080/...` on a default Docker install, the
  bridge gateway). The listener is bound on `0.0.0.0` so the container can
  reach it; `./hevc-chrome untunnel` closes it.
- The WebRTC media itself never goes through a tunnel. Chrome sends ICE
  checks from the container's bridge address, the host NATs them, and the
  camera nominates the reflexive pair. That is why the container stays on
  the default bridge network (trap 8).

A passing run:

```
click #mj-stream-0: clicked
{ "badge": "H265 2592×1520 · 24 fps · 57%", "inbound": [ { "kind": "video",
  "codec": "video/H265 level-id=186;profile-id=1;tier-flag=0;tx-mode=SRST",
  "framesDecoded": 339, "framesDropped": 0, "frameWidth": 2592, "framesPerSecond": 24, ... } ],
  "answerVideo": "m=video 48468 UDP/TLS/RTP/SAVPF 49 | a=rtpmap:49 H265/90000 | a=fmtp:49 level-id=186;..." }
PASS: 339 frames of video/H265 level-id=186;profile-id=1;tier-flag=0;tx-mode=SRST
```

## Watching the Live page over MSE

The `preview` task above only sees WebRTC. The `live` task drives the whole
Live page as a person would, over whichever transport the page (or a
remembered choice) picks, and is built for the MSE path in particular — where
the picture is fMP4 fragments over a `/ws/video` WebSocket rather than an
`RTCPeerConnection` that `getStats()` can read.

```sh
CAMERA_USER=root CAMERA_PASS='...' \
./hevc-chrome live http://<camera>/cgi-bin/live.cgi 60000 mse 0
```

`transport` is `mse` or `webrtc` and `stream` is `0` (Main) or `1` (Sub); both
are written into the page's own `localStorage` keys before its scripts run, so
the run reproduces exactly what a viewer with that remembered choice sees. Both
are optional — omit them to let the page choose.

Each second it prints the open `/ws/video` sockets (page-side and the camera's
own `ws_video_clients_total`), the visible element's decoded/dropped frame
counts, how many init segments the socket has carried, how many times the
element was handed a fresh source, and the received-vs-encoded byte ratio. Two
failures it is designed to catch:

- **More than one `/ws/video` session for one tab** — a socket leak
  (majestic-webui#298). Counted on both ends.
- **The visible player rebuilding MediaSource repeatedly** — the camera
  re-emitting the fMP4 init segment (say once per keyframe) makes the MSE
  player tear the decoder down and build it again each time, which is a black
  flash in Safari and a stall-and-restart loop in Chrome
  (majestic-webui#269/#335). The signature is `init segments seen` climbing
  while decoded frames never accumulate and `visible-element rebuilds` grows;
  the run fails past `MAX_REBUILDS` (default 3). A camera that re-announces the
  stream but whose player *absorbs* it shows the inits climbing with rebuilds
  staying at 1 — which is how a fix is proven.

## Testing the data channel

A camera that carries its live fMP4 bitstream over a WebRTC data channel
(OpenIPC/majestic-webui#285) answers a data-only offer on the same
signalling socket the media path uses (`/ws/webrtc?stream=N`). The `dc`
task is that offer, made by real Chrome, with a pre-negotiated channel
(`id 0`, unordered, no retransmits) the way a page would open one:

```
CAMERA_USER=... CAMERA_PASS=... ./hevc-chrome dc http://camera/ 16 1
CAMERA_USER=... CAMERA_PASS=... ./hevc-chrome dc http://camera/ 16 1 dcep    # in-band open
CAMERA_USER=... CAMERA_PASS=... ./hevc-chrome dc http://camera/ 16 1 mixed   # a video track beside it
```

Every message is checked against the header the camera publishes (magic
`0xA5`, version 1, kind, flags, part/parts, seq, queue delay) and the first
box of its payload (`ftyp` for an init segment, `moof` or `prft` for a
frame). Halfway through, a keyframe is requested both ways a page can ask —
on the channel and on the signalling socket — and the fresh init segment
and keyframe are timed. The verdict fails on a declined section (a camera
without the support answers port 0), a channel that never opens, a bad
header, or an unanswered request; it reports frame rate, sequence holes,
camera-flagged gaps, late arrivals, `prft` presence, split messages (a 4K
keyframe exceeds Chrome's 256 KiB message limit) and the camera's own
`dc=` stats keys. The page-side probe lives in `web/dc-probe.js` so another
browser under another driver can run the identical check.

## Measuring a feed

`bench` is the instrument behind a WebSocket-versus-data-channel comparison: the same Live page, camera and decoder, one feed pinned per run, and the players' own per-second stats teed off the page (not read off its panel) and aggregated after a warm-up. Every run reports the lag percentiles, the frame rate, the dropped and discarded frames, the stalls, the camera-flagged gaps and sequence holes, the received bit rate and the round trip, and whether the requested feed and decoder held on every tick with the tab visible — a run that drifted to the other feed is a FAIL, not a number. Alternate the feeds (`WS DC DC WS …`) and take medians; put the browser behind an impaired path (a container with `tc netem`, joined with `DOCKER_EXTRA="--network container:<netns>"`) to measure loss and capacity cells. `WASM_BASE` points the software rung at a decoder build served elsewhere; `BENCH_ICE` names a relay for the cells where only a relay can carry the session.

## How it works

1. The container gets `/dev/dri` and the render node's group. It runs as the
   invoking user with Chrome's own sandbox on (Docker's default seccomp
   profile blocks the user namespaces Chrome's sandbox needs, hence
   `--security-opt seccomp=unconfined`).
2. `docker/entry.sh` starts `weston --backend=headless --renderer=gl`. The GL
   renderer puts Weston on the Intel GPU through surfaceless EGL and makes it
   advertise dma-buf import.
3. A full (not headless) Chrome runs on that Wayland display with
   `--ozone-platform=wayland`. On Chrome 152 no feature flags are needed:
   `AcceleratedVideoDecodeLinuxGL` and `PlatformHEVCDecoderSupport` are on by
   default, and once a platform HEVC decoder exists WebRTC advertises
   `video/H265` receive (Main and Main10, level-id 186) on its own.
4. `cdp.mjs` talks to Chrome over `--remote-debugging-pipe` (plain node, no
   puppeteer), creates a target, navigates, evaluates a probe in the page and
   decides pass or fail.

## Traps

Each of these cost real time and produces a symptom that points somewhere
else. They are the reason this repository exists.

1. **`libpci3` must be in the image.** Chrome loads `libpci.so.3` to learn
   the GPU's PCI ids. Without it `SystemInfo.getInfo` reports
   `vendorId: 0, deviceId: 0`, and Chrome's VA-API setup
   (`VADisplayStateSingleton::PreSandboxInitialization`) only accepts a
   render node whose PCI ids match the active GPU, so it rejects every device
   and VA-API silently never initialises. `libva` is never even opened. The
   only symptom is one VERBOSE1 line under `--vmodule=*vaapi*=2`: "Either
   PreSandboxInitialization() hasn't been called or that method failed to
   find a suitable render node". `--render-node-override=/dev/dri/renderD128`
   bypasses the check; the package is the fix. `sysinfo` fails on ids 0/0.
2. **`--headless` cannot show hardware-decoded frames.** With Chrome's
   headless Ozone platform the codec probes pass and the VA-API decoder
   starts, then every codec (H.264 too) dies after a handful of frames with
   `PIPELINE_ERROR_DECODE`; the renderer logs `DecoderStatus::5`
   (kDisconnected) and `::108` (kDecoderStreamInErrorState). The GPU-process
   log has the real error: `Could not find SharedImageBackingFactory with
   params: ... gmb_type: platform ... debug_label: MailboxVideoFrameConverter`,
   then "Restarting GPU process due to unrecoverable error. Context was
   lost" (exit code 8704 = 34 << 8). The headless platform has no
   native-pixmap import and the `exit_on_context_lost` workaround turns that
   into a GPU process restart. It is not a GPU hang: the host kernel log was
   clean and ffmpeg decoded the same clips. Zero-copy off, Mesa compression
   off, `--disable-gpu-sandbox`, `--no-sandbox`, the Vulkan ANGLE backend:
   none help. A full Chrome on headless Weston fixes it. `--headless` forces
   `--ozone-platform=headless`, so the two cannot be combined.
3. **`--use-angle=gl` wants an X display.** On the headless platform the GPU
   process only comes up on the real GPU with `--use-gl=angle
   --use-angle=gl-egl` and `EGL_PLATFORM=surfaceless` (Mesa's default EGL
   platform tries X11 first). On Wayland the defaults work, which is one more
   reason to be there.
4. `--no-sandbox` is not what blocks VA-API; tested both ways.
5. `SystemInfo.getInfo().videoDecoding` is always empty on Linux. Chromium's
   `gpu_init.cc` never fills it there. Use `caps` and a real playback.
6. Decoder status numbers seen in logs come from
   `media/base/decoder_status.h`: 5 = kDisconnected (the GPU-side decoder
   went away), 108 = kDecoderStreamInErrorState. Neither names the cause;
   the GPU process log does.
7. A `file:` video only loads from a `file:` page (hence `web/blank.html`);
   from `about:blank` Chrome answers "Media load rejected by URL safety
   check".
8. With `--network host` Chrome offers every host interface as an ICE
   candidate; the peer keeps switching between candidate pairs, the session
   comes up and no RTP arrives. The default bridge network gives Chrome one
   interface and one nominated pair.
9. `getStats()` never exposed `decoderImplementation` /
   `powerEfficientDecoder` here, even with fake media device flags and an
   insecure origin treated as secure. Do not chase it: Chrome has no software
   HEVC decoder, so an HEVC stream that decodes at all is decoding on the
   GPU.
10. A development sandbox may hide `/dev/dri` and `/sys` from the shell while
    the Docker daemon on the host still has them. The runner asks for the
    render group id through a container when `stat` cannot see the node.
11. Killing a background ssh tunnel with `pkill -f <pattern>` from the same
    shell command that started it kills that shell: the pattern matches its
    own command line. The runner uses a pid file.
12. Evaluate in a page only after its load event. Evaluating while the
    navigation commits destroys the execution context and the DevTools call
    never returns, which looks exactly like a hung server.

## Layout

```
hevc-chrome          runner script; every subcommand is a docker run
Dockerfile           Ubuntu noble + Chrome stable + iHD VA-API + Mesa + Weston + node
docker/entry.sh      in-container entrypoint: Weston on the GPU, then cdp.mjs
docker/make-clips.sh generates the synthetic test clips
cdp.mjs              DevTools driver with the sysinfo / caps / play / preview tasks
web/blank.html       file: page that play navigates to before loading a file: video
clips/               generated clips, gitignored
CLAUDE.md            orientation for AI agents using this in QA tasks
```
