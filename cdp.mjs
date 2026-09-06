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
  } else {
    throw new Error('unknown task ' + task);
  }
  return ok;
}

main().then(ok => { proc.kill('SIGKILL'); process.exit(ok ? 0 : 1); },
            e => { console.error('HARNESS FAILURE:', e.message); for (const l of stderrLines.slice(-30)) console.error(l.slice(0, 300)); proc.kill('SIGKILL'); process.exit(2); });
