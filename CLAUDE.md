# CLAUDE.md

Orientation for an AI agent using this repository in a QA task. `README.md`
has the full story and the list of traps; this file is the short version of
what to run and what not to change.

## What this is

A Docker image that runs **Google Chrome with hardware (VA-API) video decode
on a headless Intel GPU**, plus a small DevTools driver (`cdp.mjs`) that turns
"does HEVC play?" into a pass/fail command. Chrome ships no software HEVC
decoder, so this is the only way a Linux box without a monitor can exercise
H.265 in a real browser: `<video>`, MSE, and WebRTC H.265 receive.

Everything runs inside the container. The host needs Docker, an Intel GPU
with `/dev/dri/renderD128`, and nothing else.

## Commands

```sh
./hevc-chrome build          # once; downloads current Chrome stable (~3 min)
./hevc-chrome selfcheck      # driver profiles + Chrome codec probes + 4K HEVC playback
./hevc-chrome caps           # codec support table; exit 1 if HEVC is unsupported
./hevc-chrome play hevc_4k.mp4              # any clip in clips/, or an http(s) url
CAMERA_USER=root CAMERA_PASS='...' ./hevc-chrome preview http://<camera>/cgi-bin/preview.cgi 15000 '#mj-stream-0' H265
CAMERA_USER=root CAMERA_PASS='...' ./hevc-chrome live http://<camera>/cgi-bin/live.cgi 60000 mse 0   # Live page over MSE; catches /ws/video leaks and init-re-emit thrash
CAMERA_USER=root CAMERA_PASS='...' ./hevc-chrome dc http://<camera>/ 16 1 [negotiated|dcep|mixed]     # the bitstream over an RTCDataChannel; probe in web/dc-probe.js
CAMERA_USER=root CAMERA_PASS='...' ./hevc-chrome bench http://<camera>/cgi-bin/live.cgi 60 datachannel 1 mse  # one measured run of a feed; JSON + PASS/FAIL
./hevc-chrome tunnel <camera-host>          # only if the container has no route to the camera;
./hevc-chrome untunnel                      # then the url is http://172.17.0.1:18080/...
./hevc-chrome sysinfo        # only when something fails: Chrome's GPU view + stderr
```

Every `chrome` task exits 0 on pass, 1 on a failed check, 2 on a harness
failure, and prints one `PASS:`/`FAIL:` line after its JSON. Read the JSON
for numbers (`totalVideoFrames`, `droppedVideoFrames`, `videoWidth`,
`inbound[].codec`, `inbound[].framesDecoded`), not the prose.

## Rules that are not negotiable

- **Never add `--headless`.** Chrome's headless platform cannot present
  hardware-decoded frames; decode starts and then the GPU process exits with
  "context was lost" for every codec. The container runs a full Chrome on a
  headless Weston instead. `CDP_HEADLESS=1` exists only to demonstrate that
  failure.
- **Keep `libpci3` in the Dockerfile.** Without it Chrome sees PCI ids 0/0
  and VA-API silently never initialises. `sysinfo` fails loudly on that.
- **Do not switch the container to `--network host`** for camera tests. One
  interface means one ICE pair; with all the host's interfaces on offer the
  peer keeps switching pairs and video never arrives.
- Run GPU tests **serially**. Results must be attributable to one run.
- Do not install Chrome, VA-API drivers or Weston on the host. The
  container is the environment; the host stays as its owner left it.
- The container runs as your uid, Chrome's own sandbox on. Do not add
  `--no-sandbox` as a fix for anything: it was tested and is not the cause of
  any failure listed here.

## Testing a camera (OpenIPC / majestic)

1. The camera's web interface signs in through its login page and a session
   cookie; there is no other supported way in. Pass the login as
   `CAMERA_USER` / `CAMERA_PASS` environment variables and the driver posts
   the same sign-in request the page's form sends, then carries the cookie.
   A refused sign-in fails the run immediately. Never paste credentials into
   a command line that ends up in a log or a commit.
2. `./hevc-chrome preview http://<camera>/cgi-bin/preview.cgi 15000
   '#mj-stream-0' H265`. The WebUI preview opens on the **sub stream** unless
   the browser remembers a choice; the click selector switches it to Main.
   Pass `H265` only if the camera's main stream is configured `codec: h265`.
3. Only when the container has no route to the camera (a lab reached over
   ssh): `./hevc-chrome tunnel <camera-host>` forwards host port 18080 to
   the camera's web port and prints the URL to use inside the container.
   `./hevc-chrome untunnel` when done.
4. Before touching a lab camera, check nobody else is mid-experiment on it
   (`ps`, recent files under `/var/log`, a majestic that is not running). Use
   another camera rather than restarting anything on a busy one. Camera
   configuration is never changed by this tool.

## Where things are

| path | what |
| --- | --- |
| `hevc-chrome` | the runner; every subcommand is a `docker run` |
| `Dockerfile` | Ubuntu noble + Chrome stable deb + iHD VA-API + Mesa + Weston + node |
| `docker/entry.sh` | in-container entrypoint: starts Weston on the GPU, runs `cdp.mjs` |
| `docker/make-clips.sh` | generates `clips/*.mp4` (HEVC 1080p, 4K, Main10; H.264 control) |
| `cdp.mjs` | the DevTools driver; add new checks here as another `task` branch |
| `web/blank.html` | `file:` page that `play` navigates to first (a `file:` video will not load from `about:blank`) |
| `clips/` | generated clips, gitignored |

## Adding a check

Add an `else if (task === '...')` branch in `cdp.mjs`. Use `navigate()` before
`evaluate()` (evaluating before the load event destroys the execution context
and the call never returns), return plain data from the page, print the JSON,
then set `ok = false` with a `FAIL:` line. Keep pass/fail decisions in the
driver, not in shell greps.

## Known-good baseline

Chrome 152.0.7977.82, Intel UHD 770 (Raptor Lake-S), iHD 24.1.0, Mesa 25.2,
Weston 13, kernel 7.0: 4K HEVC clip 33 frames / 0 dropped in 1.5 s; live
WebRTC H.265 2592x1520 from a hi3516ev300 camera at 24 fps, 0 dropped.
