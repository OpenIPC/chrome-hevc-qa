#!/usr/bin/env node
// Minimal Chrome DevTools driver over --remote-debugging-pipe (fds 3 and 4,
// NUL-separated JSON). No npm packages: plain node >= 18.
//
//   node cdp.mjs <chrome-binary> <task> [task args...] [-- <chrome flags...>]
//
// Tasks (all print to stdout; exit 0 = pass, 1 = the check failed, 2 = the
// harness itself broke):
//   sysinfo                          GPU feature status as Chrome sees it
//   caps                             codec support probes (<video>, MSE,
//                                    mediaCapabilities, WebRTC receive/send);
//                                    fails unless HEVC Main is supported
//   play <url> [offscreen]           play a video, report decoded size and
//                                    frame counts; fails on a media error or
//                                    fewer than MIN_FRAMES (env, default 10)
//   preview <url> [waitMs] [clickSelector] [expectCodec]
//                                    load a page that opens its own WebRTC
//                                    session, optionally click something
//                                    after 3 s, then report what the
//                                    RTCPeerConnection(s) negotiated and
//                                    decoded; fails without inbound video
//                                    frames, or if the codec is not
//                                    expectCodec (e.g. H265)
//   live <url> [waitMs] [transport] [stream]
//                                    load the WebUI Live page, optionally
//                                    with a remembered transport ('mse' or
//                                    'webrtc') and stream (0 or 1), and
//                                    report once a second every WebSocket
//                                    the page holds, the visible element's
//                                    frame counts and the camera's own
//                                    consumer gauges; fails if one tab ever
//                                    holds more than one /ws/video session
//                                    FORCE_SOFTWARE=1 makes the page's MSE
//                                    refuse HEVC so the Live page walks to its
//                                    software (WebAssembly) rung; the check is
//                                    then that the rung painted its canvas.
//                                    WASM_BASE=<url> points the rung at a
//                                    decoder build served elsewhere; FEED=
//                                    datachannel|websocket pins how the
//                                    buffered players take their bytes
//   watch <url> [waitMs] [expr]      load a page and print what <expr>
//                                    evaluates to once a second (a promise
//                                    is awaited), for probing a page's own
//                                    state while the camera is poked
//   bench <url> [seconds] [feed] [stream] [decoder]
//                                    one measured Live-page run over the
//                                    buffered transport (mse, or the software
//                                    rung with decoder=wasm) with the bytes
//                                    carried by feed=datachannel|websocket:
//                                    lag percentiles from the fragments'
//                                    producer reference times, fps, drops,
//                                    gaps, stalls, bit rate, round trip, as
//                                    JSON (BENCH_OUT=file, BENCH_LABEL=name,
//                                    BENCH_WARMUP_S=10, BENCH_SAMPLES=1 keeps
//                                    the per-second samples); fails unless the
//                                    requested feed and decoder held every
//                                    tick with the tab visible
//   dc <url> [seconds] [stream] [mode] the camera's video bitstream over an
//                                    RTCDataChannel: offer a data-only
//                                    PeerConnection on /ws/webrtc?stream=N,
//                                    check every message's header and first
//                                    box, ask for a keyframe halfway, report
//                                    rates, holes, gaps and the camera's own
//                                    dc= stats; fails on a declined section,
//                                    a channel that never opens, a bad
//                                    header, or an unanswered request;
//                                    mode negotiated (default), dcep (an
//                                    in-band open) or mixed (video beside it)
//
// Environment: CAMERA_USER / CAMERA_PASS sign in to the camera's web
// interface for http(s) urls (play and preview): a POST to /login from the
// sign-in page, then the session cookie does the rest. CDP_HEADLESS=1 adds
// --headless=new (only for demonstrating
// that headless cannot present hardware frames), CDP_NO_SANDBOX=1 adds
// --no-sandbox (needed when running as root), CDP_ALL_STDERR=1 prints every
// Chrome stderr line instead of the media-related ones.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [, , chrome, task, ...rest] = process.argv;
const sep = rest.indexOf('--');
const taskArgs = sep < 0 ? rest : rest.slice(0, sep);
const extraFlags = sep < 0 ? [] : rest.slice(sep + 1);

const flags = [
  ...(process.env.CDP_HEADLESS === '1' ? ['--headless=new'] : []),
  ...(process.env.CDP_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
  '--remote-debugging-pipe',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage',
  '--user-data-dir=/tmp/cdp-profile-' + process.pid, '--crash-dumps-dir=/tmp',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-logging=stderr', '--log-level=1',
  ...extraFlags,
];

if (!chrome || !task) {
  console.error('usage: node cdp.mjs <chrome> <sysinfo|caps|play|preview> [args] [-- chrome flags]');
  process.exit(2);
}

const proc = spawn(chrome, flags, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
const stderrLines = [];
proc.stderr.on('data', d => { for (const l of d.toString().split('\n')) if (l.trim()) stderrLines.push(l); });

let buf = '';
let nextId = 1;
const pending = new Map();
const listeners = [];
proc.stdio[4].on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else for (const l of listeners) l(msg);
  }
});
function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, m => m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result));
    proc.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
}
function waitEvent(method, sessionId, timeoutMs = 30000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting ' + method)), timeoutMs);
    listeners.push(m => { if (m.method === method && (!sessionId || m.sessionId === sessionId)) { clearTimeout(t); res(m.params); } });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function evaluate(sid, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
// Always wait for the load event before evaluating: evaluating while the
// navigation commits destroys the execution context and the call never
// returns, which looks exactly like a hung server.
async function navigate(sid, url) {
  const loaded = waitEvent('Page.loadEventFired', sid);
  await send('Page.navigate', { url }, sid);
  await loaded;
}
// Optional sign-in for the page under test (CAMERA_USER / CAMERA_PASS). It
// is the same request the camera's own sign-in page sends -- a POST to
// /login from that page's origin -- so Chrome stores the session cookie the
// way it would for a person, and every later request, fetch and WebSocket
// upgrade carries it. Returns true when signed in or when no credentials
// were given, false (with a FAIL line) when the camera refused them.
async function signIn(sid, url) {
  const user = process.env.CAMERA_USER;
  if (!user || !/^https?:/i.test(url)) return true;
  const origin = new URL(url).origin;
  await navigate(sid, origin + '/login.html');
  const status = await evaluate(sid, `fetch('/login', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: ${JSON.stringify(user)}, password: ${JSON.stringify(process.env.CAMERA_PASS || '')} }).toString() })
    .then(r => r.status, () => -1)`);
  console.log('sign-in as ' + user + ' at ' + origin + ': HTTP ' + status);
  if (status === 200) return true;
  console.log('FAIL: sign-in refused (HTTP ' + status + ')');
  return false;
}
function printStderr(re) {
  console.log('--- chrome stderr ---');
  const seen = new Set();
  for (const l of stderrLines) {
    if (/dbus|Fontconfig|GDK_IS_SEAT/.test(l)) continue;
    if (process.env.CDP_ALL_STDERR !== '1' && !re.test(l)) continue;
    const key = l.replace(/^\[[^\]]*\]/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(l.slice(0, 400));
  }
}

async function main() {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  let ok = true;

  if (task === 'sysinfo') {
    const info = await send('SystemInfo.getInfo');
    const g = info.gpu;
    console.log('GPU devices:', JSON.stringify(g.devices.map(d => ({ vendorId: d.vendorId, deviceId: d.deviceId, vendor: d.vendorString, device: d.deviceString, driver: d.driverVersion }))));
    const fs = g.featureStatus || {};
    console.log('featureStatus:', JSON.stringify(Object.fromEntries(Object.entries(fs).filter(([k]) => /video|gl|vulkan|raster|compositing|webgl/i.test(k)))));
    const aux = g.auxAttributes || {};
    console.log('aux:', JSON.stringify(Object.fromEntries(Object.entries(aux).filter(([k]) => /gl_|angle|vulkan|display|sandbox|ozone|passthrough/i.test(k)))));
    console.log('driverBugWorkarounds:', JSON.stringify(g.driverBugWorkarounds || []));
    // videoDecoding is always [] on Linux (gpu_init.cc never fills it); printed
    // so nobody wastes time wondering whether it should say something.
    console.log('videoDecoding (always empty on Linux):', JSON.stringify(info.videoDecoding || []));
    const dev = g.devices[0] || {};
    if (!dev.vendorId) { console.log('FAIL: vendorId is 0 - Chrome cannot see the GPU PCI ids (libpci3 missing?)'); ok = false; }
    if (fs.video_decode !== 'enabled') { console.log('FAIL: video_decode is ' + fs.video_decode); ok = false; }
    printStderr(/vaapi|VA-API|libva|ERROR|angle|ANGLE|EGL|vulkan/i);
  } else if (task === 'caps') {
    await navigate(sid, 'about:blank');
    const out = await evaluate(sid, `(async () => {
      const codecs = {
        'H.264 High':      'video/mp4; codecs="avc1.640028"',
        'HEVC Main L4.1':  'video/mp4; codecs="hvc1.1.6.L123.B0"',
        'HEVC Main L5.1':  'video/mp4; codecs="hvc1.1.6.L153.B0"',
        'HEVC Main hev1':  'video/mp4; codecs="hev1.1.6.L153.B0"',
        'HEVC Main10':     'video/mp4; codecs="hvc1.2.4.L153.B0"',
        'AV1 Main':        'video/mp4; codecs="av01.0.08M.08"',
      };
      const v = document.createElement('video');
      const rows = [];
      let hevc = false;
      for (const [name, ct] of Object.entries(codecs)) {
        let mc = null;
        try {
          const r = await navigator.mediaCapabilities.decodingInfo({ type: 'media-source',
            video: { contentType: ct, width: 3840, height: 2160, bitrate: 8000000, framerate: 20 } });
          mc = (r.supported ? 'supported' : 'unsupported') + (r.powerEfficient ? ',powerEfficient' : '') + (r.smooth ? ',smooth' : '');
        } catch (e) { mc = 'error ' + e.message; }
        const mse = MediaSource.isTypeSupported(ct);
        if (name === 'HEVC Main L5.1' && mse) hevc = true;
        rows.push([name.padEnd(16), 'canPlayType=' + JSON.stringify(v.canPlayType(ct)), 'MSE=' + mse, 'mediaCapabilities=' + mc].join('  '));
      }
      const fmt = c => c.mimeType + (c.sdpFmtpLine ? ' ' + c.sdpFmtpLine : '');
      const rx = RTCRtpReceiver.getCapabilities('video').codecs.map(fmt);
      const tx = RTCRtpSender.getCapabilities('video').codecs.map(fmt);
      const uniq = a => [...new Set(a)];
      return { text: rows.join('\\n')
        + '\\nWebRTC receive video codecs: ' + uniq(rx.map(s => s.split(' ')[0])).join(', ')
        + '\\nWebRTC receive H265 lines: ' + (rx.filter(s => /H265/i.test(s)).join(' | ') || '(none)')
        + '\\nWebRTC send H265 lines: ' + (tx.filter(s => /H265/i.test(s)).join(' | ') || '(none)'), hevc };
    })()`);
    console.log(out.text);
    if (!out.hevc) { console.log('FAIL: HEVC Main is not supported (no hardware decoder reachable)'); ok = false; }
    else console.log('PASS: HEVC Main supported');
  } else if (task === 'eval') {
    // eval <url> [waitMs]: load a page, wait for it to set window.__result,
    // print that JSON. A generic escape hatch for one-off browser probes.
    const url = taskArgs[0];
    if (!url) throw new Error('eval needs a url');
    const waitMs = +(taskArgs[1] || 8000);
    listeners.push(m => {
      if (m.sessionId === sid && m.method === 'Runtime.consoleAPICalled')
        console.log('console.' + m.params.type + ': ' + m.params.args.map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ').slice(0, 400));
    });
    await navigate(sid, url);
    const t0 = Date.now();
    let out = null;
    while (Date.now() - t0 < waitMs) {
      const r = await evaluate(sid, 'window.__result ? JSON.stringify(window.__result) : null');
      if (r) { out = r; break; }
      await sleep(300);
    }
    if (out == null) { console.log('FAIL: window.__result never set within ' + waitMs + 'ms; title=' + JSON.stringify((await evaluate(sid, 'document.title')))); ok = false; }
    else { console.log(out); const parsed = JSON.parse(out); if (parsed.verdict && /^BUG|NOT-REPRO|INCONCL/.test(parsed.verdict)) console.log('VERDICT: ' + parsed.verdict + ' | fix_ok=' + parsed.fix_ok); }
    printStderr(/webgl|WebGL|GL_|gpu|GPU|Context|OffscreenCanvas|ANGLE|EGL/i);
  } else if (task === 'play') {
    const url = taskArgs[0];
    if (!url) throw new Error('play needs a url');
    const minFrames = +(process.env.MIN_FRAMES || 10);
    // A file: video only loads from a file: page; about:blank rejects it with
    // "Media load rejected by URL safety check".
    if (!(await signIn(sid, url))) return false;
    await navigate(sid, url.startsWith('file:') ? 'file:///opt/web/blank.html' : 'about:blank');
    const out = await evaluate(sid, `(async () => {
      const v = document.createElement('video');
      v.muted = true; v.autoplay = true; v.playsInline = true;
      if (${JSON.stringify(taskArgs[1] || '')} !== 'offscreen') document.body.appendChild(v);
      const events = [];
      for (const e of ['loadedmetadata','loadeddata','canplay','playing','error','stalled','ended']) v.addEventListener(e, () => events.push(e + '@' + Math.round(performance.now())));
      v.src = ${JSON.stringify(url)};
      const t0 = performance.now();
      try { await v.play(); } catch (e) { events.push('play() rejected: ' + e.message); }
      while (performance.now() - t0 < ${+(process.env.PLAY_TIMEOUT_MS || 15000)}) {
        const q = v.getVideoPlaybackQuality();
        if (q.totalVideoFrames >= ${+(process.env.PLAY_FRAMES || 30)} || v.error || v.ended) break;
        await new Promise(r => setTimeout(r, 200));
      }
      const q = v.getVideoPlaybackQuality();
      return {
        readyState: v.readyState, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
        currentTime: +v.currentTime.toFixed(2), duration: +v.duration.toFixed(2),
        totalVideoFrames: q.totalVideoFrames, droppedVideoFrames: q.droppedVideoFrames,
        error: v.error ? (v.error.code + ' ' + v.error.message) : null,
        elapsedMs: Math.round(performance.now() - t0), events,
      };
    })()`);
    console.log(JSON.stringify(out, null, 1));
    if (out.error) { console.log('FAIL: media error: ' + out.error); ok = false; }
    else if (out.totalVideoFrames < minFrames) { console.log('FAIL: only ' + out.totalVideoFrames + ' frames decoded (< ' + minFrames + ')'); ok = false; }
    else console.log('PASS: ' + out.totalVideoFrames + ' frames at ' + out.videoWidth + 'x' + out.videoHeight);
    printStderr(/vaapi|VA-API|libva|decoder|Decoder|hevc|HEVC|h265|H265|GPU process|Context was lost|SharedImage/i);
  } else if (task === 'preview') {
    const url = taskArgs[0];
    if (!url) throw new Error('preview needs a url');
    const waitMs = +(taskArgs[1] || 8000);
    const clickSel = taskArgs[2] || '';
    const expectCodec = taskArgs[3] || '';
    // The hook must be in place before the page's own scripts run.
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__pcs = [];
      const Orig = window.RTCPeerConnection;
      const Hooked = function(...a) { const pc = new Orig(...a); window.__pcs.push(pc); return pc; };
      Hooked.prototype = Orig.prototype; Object.setPrototypeOf(Hooked, Orig);
      window.RTCPeerConnection = Hooked;` }, sid);
    if (!(await signIn(sid, url))) return false;
    await navigate(sid, url);
    if (clickSel) {
      await sleep(3000);
      const r = await evaluate(sid, `(() => { const e = document.querySelector(${JSON.stringify(clickSel)}); if (!e) return 'not found'; e.click(); return 'clicked'; })()`);
      console.log('click ' + clickSel + ': ' + r);
      if (r !== 'clicked') ok = false;
    }
    await sleep(waitMs);
    const out = await evaluate(sid, `(async () => {
      const v = document.querySelector('video');
      const badge = document.querySelector('#mj-badge');
      const res = { title: document.title, videoWidth: v && v.videoWidth, videoHeight: v && v.videoHeight, readyState: v && v.readyState,
                    badge: badge && badge.textContent.trim(), peerConnections: (window.__pcs || []).length, inbound: [] };
      if (v) { const q = v.getVideoPlaybackQuality(); res.totalVideoFrames = q.totalVideoFrames; res.droppedVideoFrames = q.droppedVideoFrames; }
      for (const pc of (window.__pcs || [])) {
        const st = await pc.getStats();
        const codecs = {}; st.forEach(s => { if (s.type === 'codec') codecs[s.id] = s; });
        st.forEach(s => { if (s.type === 'inbound-rtp') res.inbound.push({ kind: s.kind,
          codec: codecs[s.codecId] && (codecs[s.codecId].mimeType + ' ' + (codecs[s.codecId].sdpFmtpLine || '')),
          packetsReceived: s.packetsReceived, framesDecoded: s.framesDecoded, framesDropped: s.framesDropped, keyFramesDecoded: s.keyFramesDecoded,
          frameWidth: s.frameWidth, frameHeight: s.frameHeight, framesPerSecond: s.framesPerSecond,
          iceConnectionState: pc.iceConnectionState, connectionState: pc.connectionState }); });
        const ld = pc.localDescription, rd = pc.currentRemoteDescription;
        if (ld) res.offerVideoCodecs = [...new Set(ld.sdp.split('\\n').filter(l => /^a=rtpmap:/.test(l)).map(l => l.trim().split(' ')[1].split('/')[0]))].join(', ');
        if (rd) res.answerVideo = rd.sdp.split('\\n').filter(l => /^m=video|^a=rtpmap|^a=fmtp/.test(l)).map(l => l.trim()).join(' | ');
      }
      return res;
    })()`);
    console.log(JSON.stringify(out, null, 1));
    const vid = out.inbound.filter(i => i.kind === 'video' && i.framesDecoded > 0);
    if (!out.peerConnections) { console.log('FAIL: the page opened no RTCPeerConnection (not the expected page? authentication?) title=' + JSON.stringify(out.title)); ok = false; }
    else if (!vid.length) { console.log('FAIL: no inbound video frames decoded'); ok = false; }
    else if (expectCodec && !vid.some(i => (i.codec || '').toUpperCase().includes(expectCodec.toUpperCase()))) {
      console.log('FAIL: decoded ' + vid.map(i => i.codec).join(' / ') + ', expected ' + expectCodec); ok = false;
    } else console.log('PASS: ' + vid.map(i => i.framesDecoded + ' frames of ' + i.codec).join('; '));
  } else if (task === 'live') {
    // live <url> [waitMs] [transport] [stream]
    //
    // Watch the WebUI's Live page carry a stream over MSE (or whatever the
    // page chooses) and count what it costs the camera. Every WebSocket the
    // page opens is recorded from before its scripts run -- url, open/close
    // times, bytes -- and once a second the page is asked for its video
    // elements' playback quality, the chip text, and the camera's own
    // /metrics consumer gauges over the same session cookie. `transport`
    // ('mse' or 'webrtc') and `stream` (0 or 1) are written into
    // localStorage the way the page's own radio buttons would, so a run can
    // reproduce a viewer's remembered choice. The check is one the page's
    // own stats panel cannot make: that a single tab holds ONE /ws/video
    // session, on the page's side and on the camera's.
    const url = taskArgs[0];
    if (!url) throw new Error('live needs a url');
    const waitMs = Math.max(3000, +(taskArgs[1]) || 30000);  // never 0: an empty run has no `last` sample
    const transport = taskArgs[2] || '';
    const stream = taskArgs[3] || '';
    // How many in-place MediaSource rebuilds the visible player may make
    // before the run is judged a re-init thrash. One initial load is normal;
    // a couple more tolerate a reconnect. Dozens is the flash. Override with
    // MAX_REBUILDS.
    const MAX_REBUILDS = +(process.env.MAX_REBUILDS || 3);
    const consoleLines = [];
    listeners.push(m => {
      if (m.sessionId !== sid) return;
      if (m.method === 'Runtime.consoleAPICalled')
        consoleLines.push(Math.round(m.params.timestamp) + ' ' + m.params.type + ': ' + m.params.args.map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ').slice(0, 300));
      else if (m.method === 'Runtime.exceptionThrown')
        consoleLines.push('exception: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text).slice(0, 300));
    });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      try {
        const tp = ${JSON.stringify(transport)}, st = ${JSON.stringify(stream)};
        if (tp) { localStorage.setItem('mj-transport-pick', tp); localStorage.removeItem('mj-transport-auto'); localStorage.removeItem('mj-transport'); }
        if (st) { localStorage.setItem('mj-preview-stream:preview', st); localStorage.removeItem('mj-preview-stream'); }
      } catch (e) {}
      // WASM_BASE: where the page fetches its software H.265 decoder from,
      // for a build that is not on the CDN yet (a directory served from this
      // host that the container can reach, e.g. http://172.17.0.1:8000/).
      // FEED: 'datachannel' or 'websocket' to pin how the buffered players
      // take their bytes, instead of the page's own choice.
      if (${JSON.stringify(process.env.WASM_BASE || '')}) window.MJ_WASM_BASE = ${JSON.stringify(process.env.WASM_BASE || '')};
      if (${JSON.stringify(process.env.FEED || '')}) window.MJ_FEED = ${JSON.stringify(process.env.FEED || '')};
      // FORCE_SOFTWARE: make the page's MSE refuse HEVC, so a Chrome that
      // decodes H.265 in hardware still walks down to the software rung
      // (the WebAssembly decoder), which is otherwise unreachable here.
      if (${JSON.stringify(!!process.env.FORCE_SOFTWARE)}) {
        const orig = MediaSource.isTypeSupported.bind(MediaSource);
        MediaSource.isTypeSupported = (t) => (/hvc1|hev1/i.test(t) ? false : orig(t));
      }
      window.__ws = [];
      const OrigWS = window.WebSocket;
      const HookedWS = function (u, p) {
        const s = p === undefined ? new OrigWS(u) : new OrigWS(u, p);
        const rec = { url: String(u).replace(/^wss?:\\/\\/[^/]+/, ''), created: Math.round(performance.now()),
                      opened: null, closed: null, code: null, bytes: 0, msgs: 0, inits: 0, texts: [], sock: s };
        s.addEventListener('open', () => { rec.opened = Math.round(performance.now()); });
        s.addEventListener('close', e => { rec.closed = Math.round(performance.now()); rec.code = e.code; });
        s.addEventListener('message', e => {
          rec.msgs++;
          if (typeof e.data === 'string') {
            // Count init announcements unbounded; keep only a few for display.
            if (/"init"/.test(e.data)) rec.inits++;
            if (rec.texts.length < 8) rec.texts.push(e.data.slice(0, 160));
          } else rec.bytes += e.data.byteLength || e.data.size || 0;
        });
        window.__ws.push(rec);
        return s;
      };
      HookedWS.prototype = OrigWS.prototype; Object.setPrototypeOf(HookedWS, OrigWS);
      for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) HookedWS[k] = OrigWS[k];
      window.WebSocket = HookedWS;
      window.__mjSample = async function () {
        const t = Math.round(performance.now());
        const sockets = window.__ws.map(r => ({ url: r.url, created: r.created, opened: r.opened, closed: r.closed,
          code: r.code, state: r.sock.readyState, bytes: r.bytes, msgs: r.msgs, inits: r.inits, texts: r.texts }));
        const videos = [...document.querySelectorAll('video')].map(v => {
          // Stalls and seeks per element, counted from the first sample that
          // sees it; the MSE player replaces its element on a reconnect, so a
          // fresh element starts from zero and says so through its counts.
          if (!v.__mj) { v.__mj = { waiting: 0, seeking: 0, srcs: 0 };
            v.addEventListener('waiting', () => v.__mj.waiting++);
            v.addEventListener('seeking', () => v.__mj.seeking++);
            v.addEventListener('loadstart', () => v.__mj.srcs++); }
          const q = v.getVideoPlaybackQuality(); let ahead = null;
          try { if (v.buffered.length) ahead = +(v.buffered.end(v.buffered.length - 1) - v.currentTime).toFixed(2); } catch (e) {}
          return { id: v.id, shown: getComputedStyle(v).display !== 'none', rs: v.readyState, w: v.videoWidth, h: v.videoHeight,
                   total: q.totalVideoFrames, dropped: q.droppedVideoFrames, ct: +v.currentTime.toFixed(2), ahead, paused: v.paused,
                   waiting: v.__mj.waiting, seeking: v.__mj.seeking, loads: v.__mj.srcs,
                   err: v.error ? v.error.code : null };
        });
        // The software rung paints a <canvas> from a worker; the only sign a
        // frame landed is the flag the player sets on it.
        const canvases = [...document.querySelectorAll('canvas')].filter(c => /^live-canvas/.test(c.id)).map(c => ({
          id: c.id, shown: getComputedStyle(c).display !== 'none' && c.offsetParent !== null, painted: !!c.__mjPainted,
          w: c.width, h: c.height }));
        const badge = document.querySelector('#mj-badge');
        let metrics = null;
        try {
          const txt = await (await fetch('/metrics', { credentials: 'same-origin', cache: 'no-store' })).text();
          metrics = {};
          for (const k of ['ws_video_clients_total', 'webrtc_sessions_total', 'venc0_rcvd_bytes', 'venc1_rcvd_bytes'])
            { const r = new RegExp('^' + k + ' (\\\\S+)', 'm').exec(txt); if (r) metrics[k] = +r[1]; }
        } catch (e) { metrics = { error: String(e) }; }
        return { t, sockets, videos, canvases, badge: badge && badge.textContent.trim(), metrics };
      };` }, sid);
    if (!(await signIn(sid, url))) return false;
    await navigate(sid, url);
    const t0 = Date.now();
    const samples = [];
    let maxPageOpen = 0, maxCamera = 0;
    // The camera-wide ws_video_clients_total gauge counts every viewer, not
    // just this tab. Baseline the others on the first reading so the leak
    // check judges only THIS run's contribution -- otherwise a second viewer
    // already watching fails a clean run. The page-side count is this tab's
    // own sockets and needs no baseline; it is watched from the first sample
    // so a leak that opens and closes during startup is not missed.
    let baseOthers = null;
    while (Date.now() - t0 < waitMs) {
      await sleep(1000);
      const s = await evaluate(sid, 'window.__mjSample()');
      samples.push(s);
      const vid = s.sockets.filter(x => /\/ws\/video/.test(x.url));
      const open = vid.filter(x => x.state === 1).length;
      const cam = s.metrics && s.metrics.ws_video_clients_total;
      if (baseOthers === null && cam != null) baseOthers = Math.max(0, cam - open);
      maxPageOpen = Math.max(maxPageOpen, open);
      if (cam != null) maxCamera = Math.max(maxCamera, cam - (baseOthers || 0));
      const live = s.videos.find(v => v.shown) || s.videos[0];
      // Bytes the page's sockets delivered this second against what the
      // encoder produced (camera counter): a ratio near 1 is one copy of the
      // stream; 2 means the page is being sent everything twice.
      const prev = samples[samples.length - 2];
      let rate = '';
      if (prev && prev.metrics && s.metrics && s.metrics.venc0_rcvd_bytes != null) {
        const dtS = (s.t - prev.t) / 1000;
        const sum = a => a.filter(x => /\/ws\/video/.test(x.url)).reduce((n, x) => n + x.bytes, 0);
        const rx = (sum(s.sockets) - sum(prev.sockets)) * 8 / 1000 / dtS;
        const ch = /stream=1/.test((vid[vid.length - 1] || {}).url || '') ? 'venc1_rcvd_bytes' : 'venc0_rcvd_bytes';
        const enc = (s.metrics[ch] - prev.metrics[ch]) * 8 / 1000 / dtS;
        rate = ` rx=${Math.round(rx)} enc=${Math.round(enc)} kbit/s${enc > 50 ? ' x' + (rx / enc).toFixed(2) : ''}`;
      }
      const inits = vid.reduce((n, x) => n + (x.inits || 0), 0);
      const canvas = (s.canvases || []).find(c => c.shown);
      console.log(`t=${(s.t / 1000).toFixed(1)}s ws/video page open=${open} of ${vid.length} camera=${cam == null ? '?' : cam}` +
        ` webrtc=${s.metrics && s.metrics.webrtc_sessions_total}${rate} inits=${inits} | ` +
        (live ? `${live.id} ${live.w}x${live.h} frames=${live.total} dropped=${live.dropped} ahead=${live.ahead}s stalls=${live.waiting} seeks=${live.seeking} loads=${live.loads} rs=${live.rs}${live.err ? ' ERR' + live.err : ''}` : 'no video') +
        (canvas ? ` | ${canvas.id} ${canvas.w}x${canvas.h} painted=${canvas.painted}` : '') +
        ` | ${s.badge || ''}`);
    }
    const last = samples[samples.length - 1];
    console.log('sockets: ' + JSON.stringify(last.sockets.map(x => ({ ...x, texts: x.texts.map(t => t.slice(0, 120)) })), null, 1));
    console.log('videos: ' + JSON.stringify(last.videos));
    if (consoleLines.length) { console.log('--- page console ---'); for (const l of consoleLines.slice(0, 60)) console.log(l); }
    // The init text frames the visible stream's socket carried, and how many
    // times the visible element was handed a fresh source. In a steady MSE
    // session both are ~1: one init, one load. A camera that re-announces the
    // stream every keyframe (majestic-webui#269/#335) drives `inits` up once
    // per keyframe; whether that COSTS anything is the reload count, because a
    // player that rebuilds MediaSource for each re-announcement resets the
    // decoder every time -- the Safari flash, and the jerky H.265 in Chrome
    // MSE. `loads` is per element instance; a socket reconnect makes a fresh
    // element (loads back to 0), so a high count on the element that ends
    // visible is repeated in-place rebuilds, not reconnects.
    if (!last) { console.log('FAIL: no samples collected (waitMs too small?)'); return false; }
    const vidLast = last.sockets.filter(x => /\/ws\/video/.test(x.url));
    const initFrames = vidLast.reduce((n, x) => n + (x.inits || 0), 0);
    const live = last.videos.find(v => v.shown);
    const reloads = live ? (live.loads || 0) : 0;
    console.log(`summary: init segments seen=${initFrames}, visible-element rebuilds=${reloads}, stalls=${live ? live.waiting : '-'}`);
    const softCanvas = (last.canvases || []).find(c => c.shown);
    if (process.env.FORCE_SOFTWARE) {
      // The software rung's verdict: a canvas on screen that the decoder
      // has painted, and the chip naming a measured H.265 rate.
      if (!softCanvas || !softCanvas.painted) { console.log('FAIL: the software rung never painted its canvas' + (live && live.total ? ' (a <video> played instead)' : '')); ok = false; }
      else if (maxPageOpen > 1 || maxCamera > 1) { console.log(`FAIL: one tab held ${maxPageOpen} open /ws/video sockets (camera counted ${maxCamera})`); ok = false; }
      else console.log(`PASS: software rung painted ${softCanvas.w}x${softCanvas.h} on one /ws/video session; chip "${last.badge || ''}"`);
    }
    else if (!live || !live.total) { console.log('FAIL: no video frames decoded on the visible element'); ok = false; }
    else if (maxPageOpen > 1 || maxCamera > 1) { console.log(`FAIL: one tab held ${maxPageOpen} open /ws/video sockets (camera counted ${maxCamera})`); ok = false; }
    else if (reloads > MAX_REBUILDS) { console.log(`FAIL: the visible player rebuilt ${reloads} times (> ${MAX_REBUILDS}) -- /ws/video init re-emit resets the MSE decoder (majestic-webui#269/#335)`); ok = false; }
    else console.log(`PASS: one /ws/video session, ${live.total} frames, ${live.dropped} dropped (${(100 * live.dropped / live.total).toFixed(1)}%), ${reloads} rebuild(s), ${initFrames} init(s)`);
    printStderr(/vaapi|VA-API|decoder|Decoder|hevc|HEVC|h265|H265|GPU process|Context was lost|SharedImage/i);
  } else if (task === 'watch') {
    // watch <url> [waitMs] [expr]: load a page, then evaluate <expr> once a
    // second and print what it returns -- a generic probe of a page's own
    // state (an alert's hidden flag, a chip's text, a canvas's painted mark)
    // while something is done to the camera from outside. <expr> may return a
    // promise, so it can also fetch the camera's /metrics over the session
    // cookie. Console lines are printed as they arrive, since the page's own
    // complaints are usually the explanation of what the probe shows.
    const url = taskArgs[0];
    if (!url) throw new Error('watch needs a url');
    const waitMs = +(taskArgs[1] || 20000);
    const expr = taskArgs[2] || 'document.title';
    listeners.push(m => {
      if (m.sessionId === sid && m.method === 'Runtime.consoleAPICalled')
        console.log('console.' + m.params.type + ': ' + m.params.args.map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ').slice(0, 300));
    });
    if (!(await signIn(sid, url))) return false;
    await navigate(sid, url);
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      let r;
      try {
        r = await evaluate(sid, `(async function () { try { return JSON.stringify(await (${expr})); } catch (e) { return 'ERR ' + e; } })()`);
      } catch (e) { r = 'EVAL-ERR ' + e.message; }
      console.log('t=' + ((Date.now() - t0) / 1000).toFixed(1) + 's ' + r);
      await sleep(1000);
    }
  } else if (task === 'dc') {
    // dc <url> [seconds] [stream]: the camera's video bitstream over an
    // RTCDataChannel. Signs in, offers a data-only PeerConnection over the
    // camera's WebRTC signalling socket (/ws/webrtc?stream=N) with one
    // pre-negotiated channel (id 0, unordered, no retransmits), and counts
    // what arrives for <seconds>: every message is checked against the
    // published header (magic 0xA5, version 1, kind, flags, part/parts, seq,
    // queue delay) and its payload's first box. Halfway through it asks for
    // a keyframe the way a page does, on the channel and on the signalling
    // socket, and expects a fresh init segment with the next keyframe.
    // Prints a JSON summary, the camera's own stats lines, and PASS/FAIL.
    const url = taskArgs[0];
    if (!url) throw new Error('dc needs a url');
    const seconds = +(taskArgs[1] || 15);
    const stream = +(taskArgs[2] || 0);
    const mode = taskArgs[3] || 'negotiated';
    // The probe is a page script shared with other browsers' checks; read
    // here and evaluated on the camera's origin.
    const probeSource = readFileSync(new URL('./web/dc-probe.js', import.meta.url), 'utf8');
    listeners.push(m => {
      if (m.sessionId === sid && m.method === 'Runtime.consoleAPICalled')
        console.log('console.' + m.params.type + ': ' + m.params.args.map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ').slice(0, 300));
    });
    if (!(await signIn(sid, url))) return false;
    // Stay on the camera's origin (the sign-in page carries no player, so
    // the probe's session is the only one this tab opens).
    const origin = new URL(url).origin;
    if (!process.env.CAMERA_USER) await navigate(sid, origin + '/login.html');
    const out = await evaluate(sid, `(async () => {
      ${probeSource}
      return window.__dcProbe(${seconds}, ${stream}, ${JSON.stringify(mode)});
    })()`);
    console.log(JSON.stringify(out, null, 1));
    const camDcUp = out.stats.some(l => /\bdc=up\b/.test(l));
    if (out.answerDeclined) { console.log('FAIL: the camera declined the data section (port 0) -- no data-channel support in this build'); ok = false; }
    else if (!out.answerHasData) { console.log('FAIL: no answer with an application section; errors: ' + JSON.stringify(out.errors)); ok = false; }
    else if (out.openAt === null) { console.log('FAIL: the channel never opened (ice ' + out.ice.join(' ') + '); errors: ' + JSON.stringify(out.errors)); ok = false; }
    else if (out.bad || out.badBox) { console.log(`FAIL: ${out.bad} message(s) with a bad header, ${out.badBox} with a wrong first box`); ok = false; }
    else if (out.kinds.init < 1 || out.kinds.initSeg < 1) { console.log('FAIL: no init messages (kinds 1/2) arrived'); ok = false; }
    else if (out.frames < 10) { console.log('FAIL: only ' + out.frames + ' frames arrived'); ok = false; }
    else if (!out.served || out.served.data !== stream || (mode !== 'mixed' && out.served.transport !== 'data') || (mode === 'mixed' && out.served.transport !== undefined)) { console.log('FAIL: served did not describe a ' + mode + ' session on stream ' + stream + ' (data + transport only when nothing else is served): ' + JSON.stringify(out.served)); ok = false; }
    else if (!camDcUp) { console.log('FAIL: the camera\'s stats line never said dc=up: ' + JSON.stringify(out.stats)); ok = false; }
    else if (out.initAfterAsk === null || out.keyframeAfterAsk === null) { console.log('FAIL: the keyframe request was not answered with an init and a keyframe (init ' + out.initAfterAsk + 'ms, keyframe ' + out.keyframeAfterAsk + 'ms)'); ok = false; }
    else if (mode === 'mixed' && !(out.videoFrames > 0)) { console.log('FAIL: mixed offer: the channel ran but no video frames decoded on the track'); ok = false; }
    else console.log(`PASS: ${mode} channel (id ${out.channelId}) open at ${out.openAt}ms, first message at ${out.firstAt}ms, ${out.frames} frames (${out.keyframes} key) at ${out.fps} fps / ${out.kbps} kbps, ${out.seqHoles} hole(s), ${out.gaps} camera-flagged gap(s), ${out.late} late, ${out.prft} with prft, ${out.multipart} part(s) of split messages, queue p95 ${out.queueMs.p95}ms; keyframe request answered by an init in ${out.initAfterAsk}ms and a keyframe in ${out.keyframeAfterAsk}ms`);
    printStderr(/sctp|SCTP|dtls|DTLS|webrtc|WebRTC|ERROR/i);
  } else if (task === 'bench') {
    // bench <url> [seconds] [feed] [stream] [decoder]: one measured run of
    // the Live page over the buffered transport — the MSE player, or with
    // decoder=wasm the software rung — with the bytes carried by the feed
    // named (datachannel|websocket), pinned through the page's own hooks.
    // Samples the players' per-second stats (teed off the page's onStats
    // callbacks, not read off the panel) and the page's visibility once a
    // second; after BENCH_WARMUP_S seconds the rest is aggregated: lag
    // percentiles from the raw capture-to-arrival samples the fragments'
    // producer reference times give, frame rate, drops, gaps, stalls,
    // reconnects, the camera-side queue, the received bit rate, the round
    // trip. PASS needs frames on every tick, the requested decoder and feed
    // on every tick, the tab visible throughout and at most one /ws/video
    // socket at a time. The JSON goes to stdout and, with BENCH_OUT, to a
    // file; BENCH_LABEL names the run inside it. Chrome runs with its
    // background throttling off so a covered window cannot skew a run.
    const url = taskArgs[0];
    if (!url) throw new Error('bench needs a url');
    const seconds = +(taskArgs[1] || 50);
    const feedWant = taskArgs[2] || 'datachannel';
    const stream = taskArgs[3] || '0';
    const decoder = taskArgs[4] || 'mse';
    const warmup = +(process.env.BENCH_WARMUP_S || 10);
    const label = process.env.BENCH_LABEL || '';
    const consoleLines = [];
    listeners.push(m => {
      if (m.sessionId !== sid) return;
      if (m.method === 'Runtime.consoleAPICalled')
        consoleLines.push(m.params.type + ': ' + m.params.args.map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ').slice(0, 200));
    });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      try {
        localStorage.setItem('mj-transport-pick', 'mse'); localStorage.removeItem('mj-transport-auto'); localStorage.removeItem('mj-transport');
        localStorage.setItem('mj-preview-stream:preview', ${JSON.stringify(String(stream))}); localStorage.removeItem('mj-preview-stream');
        localStorage.removeItem('mj-feed-auto');
      } catch (e) {}
      window.MJ_FEED = ${JSON.stringify(feedWant)};
      if (${JSON.stringify(process.env.WASM_BASE || '')}) window.MJ_WASM_BASE = ${JSON.stringify(process.env.WASM_BASE || '')};
      // BENCH_ICE: a JSON iceServers list the page uses instead of the
      // camera's — a relay on this side, for the cells where only a relay
      // can carry the session.
      if (${JSON.stringify(process.env.BENCH_ICE || '')}) { try { window.MJ_ICE = JSON.parse(${JSON.stringify(process.env.BENCH_ICE || '')}); } catch (e) {} }
      if (${JSON.stringify(decoder === 'wasm')}) {
        const orig = MediaSource.isTypeSupported.bind(MediaSource);
        MediaSource.isTypeSupported = (t) => (/hvc1|hev1/i.test(t) ? false : orig(t));
      }
      // Tee every player's per-second stats. The players are globals the
      // page's scripts assign later; an accessor installed now wraps attach()
      // on assignment so opts.onStats is observed without the page knowing.
      window.__mjBench = { samples: [], t0: Date.now() };
      for (const name of ['MajesticVideo', 'MajesticWasm']) {
        let real;
        Object.defineProperty(window, name, {
          configurable: true, enumerable: true,
          get() { return real; },
          set(v) {
            real = v;
            if (!v || typeof v.attach !== 'function') return;
            const attach = v.attach;
            v.attach = function (el, opts) {
              opts = Object.assign({}, opts || {});
              const inner = opts.onStats;
              opts.onStats = (s) => {
                try { window.__mjBench.samples.push(Object.assign({ at: Date.now(), player: name, visible: document.visibilityState }, s)); } catch (e) {}
                if (inner) inner(s);
              };
              return attach.call(this, el, opts);
            };
          },
        });
      }
    ` }, sid);
    if (!(await signIn(sid, url))) return false;
    await navigate(sid, url);
    await send('Page.bringToFront', {}, sid);
    const t0 = Date.now();
    let camCount = [];
    while (Date.now() - t0 < seconds * 1000) {
      await sleep(1000);
      // The camera's own socket count, so a leaked session shows up as a
      // count of two whether or not the page noticed.
      try {
        const r = await evaluate(sid, `fetch('/metrics', { credentials: 'same-origin' }).then(r => r.text()).then(t => { const m = /^ws_video_clients_total (\\d+)/m.exec(t); const d = /^webrtc_data_sessions (\\d+)/m.exec(t); return { ws: m ? +m[1] : null, dc: d ? +d[1] : null }; }).catch(() => null)`);
        if (r) camCount.push(r);
      } catch (e) {}
    }
    const out = await evaluate(sid, `(function () {
      const b = window.__mjBench || { samples: [] };
      const wsOpen = Array.from(document.querySelectorAll('*')).length && 0;
      return { samples: b.samples, t0: b.t0, socketsNow: 0 };
    })()`);
    const all = out.samples || [];
    const cut = t0 + warmup * 1000;
    const kept = all.filter(s => s.at >= cut);
    const pct = (a, p) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
    const lag = [];
    kept.forEach(s => { if (Array.isArray(s.lagMs)) lag.push(...s.lagMs); });
    const first = kept[0], last = kept[kept.length - 1];
    const delta = (k) => (last && first && typeof last[k] === 'number' && typeof first[k] === 'number') ? last[k] - first[k] : null;
    const durS = kept.length > 1 ? (last.at - first.at) / 1000 : 0;
    const frames = kept.map(s => s.totalFrames != null ? s.totalFrames : s.framesDecoded).filter(v => typeof v === 'number');
    const fps = frames.length > 1 && durS > 0 ? (frames[frames.length - 1] - frames[0]) / durS : null;
    const rtts = kept.map(s => s.dc && s.dc.rttMs).filter(v => typeof v === 'number');
    const queued = kept.map(s => s.dc && s.dc.queueMs).filter(v => typeof v === 'number');
    const rx = delta('rxBytes');
    const feeds = kept.map(s => s.feed), decoders = kept.map(s => s.transport);
    const wantDecoder = decoder === 'wasm' ? 'wasm' : 'mse';
    const res = {
      label, url, feed: feedWant, stream: +stream, decoder: wantDecoder, seconds, warmupS: warmup,
      samples: kept.length, framesPerTickOk: kept.length > 0 && kept.every(s => (s.totalFrames || s.framesDecoded || 0) > 0),
      feedEvery: kept.length > 0 && feeds.every(f => f === feedWant),
      decoderEvery: kept.length > 0 && decoders.every(d => d === wantDecoder),
      visibleEvery: kept.length > 0 && kept.every(s => s.visible === 'visible'),
      lag: lag.length ? { n: lag.length, p50: pct(lag, 0.5), p95: pct(lag, 0.95), p99: pct(lag, 0.99), max: pct(lag, 1) } : null,
      fps: fps != null ? +fps.toFixed(2) : null,
      frames: frames.length > 1 ? frames[frames.length - 1] - frames[0] : null,
      dropped: delta('droppedFrames') != null ? delta('droppedFrames') : delta('framesDropped'),
      gopDrops: delta('gopDrops'), idrRequests: delta('idrRequests'), stalls: delta('stalls'), discarded: delta('discarded'),
      bufferedMsP95: pct(kept.map(s => s.bufferedMs).filter(v => typeof v === 'number'), 0.95),
      queuedMsP95: pct(kept.map(s => s.queuedMs).filter(v => typeof v === 'number'), 0.95),
      camQueueMsP95: queued.length ? pct(queued, 0.95) : null,
      seqGaps: last && last.dc ? last.dc.seqGaps : null, camGaps: last && last.dc ? last.dc.camGaps : null, late: last && last.dc ? last.dc.late : null,
      rxKbps: rx != null && durS > 0 ? Math.round(rx * 8 / 1000 / durS) : null,
      rttMs: rtts.length ? pct(rtts, 0.5) : null,
      camLine: last && last.dc && last.dc.cam ? last.dc.cam : null,
      camWs: camCount.length ? Math.max(...camCount.map(c => c.ws || 0)) : null,
      camDc: camCount.length ? Math.max(...camCount.map(c => c.dc || 0)) : null,
      console: consoleLines.slice(0, 8),
    };
    // BENCH_SAMPLES=1 keeps the per-second samples themselves (minus the raw
    // lag arrays), so a run's shape — when a gap came, how long the picture
    // waited for a keyframe, what the camera's counters did — can be read
    // back instead of inferred from the totals.
    if (process.env.BENCH_SAMPLES) res.timeline = kept.map(s => { const o = Object.assign({}, s); delete o.lagMs; o.t = +((s.at - t0) / 1000).toFixed(1); delete o.at; return o; });
    res.pass = res.samples >= Math.max(3, (seconds - warmup) / 2) && res.framesPerTickOk && res.feedEvery && res.decoderEvery && res.visibleEvery && (res.camWs == null || res.camWs <= 1) && (res.camDc == null || res.camDc <= 1);
    res.reason = !res.samples ? 'no samples after warm-up' : !res.framesPerTickOk ? 'a tick with no frames' : !res.feedEvery ? 'feed was ' + JSON.stringify([...new Set(feeds)]) : !res.decoderEvery ? 'decoder was ' + JSON.stringify([...new Set(decoders)]) : !res.visibleEvery ? 'the tab was not visible throughout' : (res.camWs > 1 || res.camDc > 1) ? 'the camera counted more than one session' : 'ok';
    const json = JSON.stringify(res, null, 1);
    console.log(json);
    if (process.env.BENCH_OUT) { try { writeFileSync(process.env.BENCH_OUT, json + '\n'); } catch (e) { console.log('FAIL: cannot write ' + process.env.BENCH_OUT + ': ' + e.message); ok = false; } }
    if (!res.pass) { console.log('FAIL: ' + res.reason); ok = false; }
    else console.log(`PASS: ${res.decoder} over ${res.feed} on stream ${res.stream}: ${res.frames} frames at ${res.fps} fps, lag p50 ${res.lag ? res.lag.p50 : '-'} p95 ${res.lag ? res.lag.p95 : '-'} ms, dropped ${res.dropped}, stalls ${res.stalls}, gaps ${res.camGaps}/${res.seqGaps}, rx ${res.rxKbps} kbps, rtt ${res.rttMs} ms`);
  } else {
    throw new Error('unknown task ' + task);
  }
  return ok;
}

main().then(ok => { proc.kill('SIGKILL'); process.exit(ok ? 0 : 1); },
            e => { console.error('HARNESS FAILURE:', e.message); for (const l of stderrLines.slice(-30)) console.error(l.slice(0, 300)); proc.kill('SIGKILL'); process.exit(2); });
