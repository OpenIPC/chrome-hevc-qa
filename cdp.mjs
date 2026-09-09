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
//                                    then that the rung painted its canvas
//   watch <url> [waitMs] [expr]      load a page and print what <expr>
//                                    evaluates to once a second (a promise
//                                    is awaited), for probing a page's own
//                                    state while the camera is poked
//
// Environment: CAMERA_USER / CAMERA_PASS sign in to the camera's web
// interface for http(s) urls (play and preview): a POST to /login from the
// sign-in page, then the session cookie does the rest. CDP_HEADLESS=1 adds
// --headless=new (only for demonstrating
// that headless cannot present hardware frames), CDP_NO_SANDBOX=1 adds
// --no-sandbox (needed when running as root), CDP_ALL_STDERR=1 prints every
// Chrome stderr line instead of the media-related ones.
import { spawn } from 'node:child_process';

const [, , chrome, task, ...rest] = process.argv;
const sep = rest.indexOf('--');
const taskArgs = sep < 0 ? rest : rest.slice(0, sep);
const extraFlags = sep < 0 ? [] : rest.slice(sep + 1);

const flags = [
  ...(process.env.CDP_HEADLESS === '1' ? ['--headless=new'] : []),
  ...(process.env.CDP_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
  '--remote-debugging-pipe',
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
  } else {
    throw new Error('unknown task ' + task);
  }
  return ok;
}

main().then(ok => { proc.kill('SIGKILL'); process.exit(ok ? 0 : 1); },
            e => { console.error('HARNESS FAILURE:', e.message); for (const l of stderrLines.slice(-30)) console.error(l.slice(0, 300)); proc.kill('SIGKILL'); process.exit(2); });
