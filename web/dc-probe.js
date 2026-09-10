// The camera's video bitstream over an RTCDataChannel: one page-side probe
// shared by the Chrome driver (cdp.mjs, task `dc`) and any other browser
// that can evaluate a script on the camera's origin (the Firefox check
// under Playwright). Installs window.__dcProbe(seconds, stream, mode).
//
// mode: 'negotiated' (default) — one pre-negotiated channel, id 0,
//       unordered, no retransmits, the way a page would open it;
//       'dcep' — a channel opened in-band (createDataChannel without
//       negotiated), so the camera has to acknowledge the open and move
//       its output to that stream;
//       'mixed' — the channel beside a recvonly video transceiver, the
//       two bundled on one transport.
//
// opts: { iceServers, iceTransportPolicy } for the RTCPeerConnection — a
//       relay for a viewer with no direct path to the camera; the default
//       is no servers, which on a LAN is enough.
//
// Every message is checked against the published header (magic 0xA5,
// version 1, kind, flags, part/parts, seq, queue delay) and its payload's
// first box. Halfway through, a keyframe is requested the two ways a page
// can ask — on the channel and on the signalling socket — and the reply is
// timed. Returns a JSON-able summary; the driver decides PASS/FAIL.
window.__dcProbe = async (seconds, stream, mode, opts) => {
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  const st = { stream, openAt: null, firstAt: null, msgs: 0, bytes: 0, bad: 0,
    kinds: { init: 0, initSeg: 0, frame: 0, control: 0 }, frames: 0, keyframes: 0, gaps: 0,
    seqHoles: 0, late: 0, prft: 0, multipart: 0, badBox: 0, queueMs: [], interMs: [],
    served: null, stats: [], errors: [], ice: [], dcState: [], answer: null,
    idrAskedAt: null, initAfterAsk: null, keyframeAfterAsk: null, codec: null };
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/webrtc?stream=' + stream;
  const ws = new WebSocket(wsUrl);
  opts = opts || {};
  const pc = new RTCPeerConnection({ iceServers: opts.iceServers || [], iceTransportPolicy: opts.iceTransportPolicy || 'all' });
  mode = mode || 'negotiated';
  st.mode = mode;
  if (mode === 'mixed') pc.addTransceiver('video', { direction: 'recvonly' });
  const dc = mode === 'dcep'
    ? pc.createDataChannel('video', { ordered: false, maxRetransmits: 0 })
    : pc.createDataChannel('video', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
  st.channelId = dc.id;
  if (mode === 'mixed') {
    st.videoFrames = 0;
    pc.ontrack = ev => {
      const v = document.createElement('video');
      v.muted = true; v.autoplay = true; v.playsInline = true; v.srcObject = ev.streams[0] || new MediaStream([ev.track]);
      document.body.appendChild(v);
      st.video = v;
    };
  }
  dc.binaryType = 'arraybuffer';
  let lastSeq = 0, lastAt = null;
  const box = (u8, at) => String.fromCharCode(u8[at + 4], u8[at + 5], u8[at + 6], u8[at + 7]);
  dc.onopen = () => { st.openAt = now(); st.dcState.push('open@' + st.openAt); };
  dc.onclose = () => st.dcState.push('close@' + now());
  dc.onerror = e => st.errors.push('dc error ' + (e.error && e.error.message));
  dc.onmessage = ev => {
    st.msgs++;
    if (typeof ev.data === 'string') { st.errors.push('text message: ' + ev.data.slice(0, 80)); return; }
    const u8 = new Uint8Array(ev.data), dv = new DataView(ev.data);
    st.bytes += u8.length;
    if (st.firstAt === null) st.firstAt = now();
    if (u8.length < 16 || u8[0] !== 0xA5 || u8[1] !== 1) { st.bad++; return; }
    const kind = u8[2], flags = u8[3], part = dv.getUint16(4), parts = dv.getUint16(6), seq = dv.getUint32(8), q = dv.getUint16(12);
    if (parts > 1) st.multipart++;
    if (kind === 1) {
      st.kinds.init++;
      try { const j = JSON.parse(new TextDecoder().decode(u8.subarray(16))); st.codec = j.codec || j.mime || JSON.stringify(j).slice(0, 80); } catch (e) { st.errors.push('init json unparseable'); }
      if (st.idrAskedAt !== null && st.initAfterAsk === null) st.initAfterAsk = now() - st.idrAskedAt;
    } else if (kind === 2) {
      st.kinds.initSeg++;
      if (part === 0 && box(u8, 16) !== 'ftyp') st.badBox++;
    } else if (kind === 3) {
      st.kinds.frame++;
      if (part === 0) {
        st.frames++;
        const t = now();
        if (lastAt !== null) st.interMs.push(t - lastAt);
        lastAt = t;
        st.queueMs.push(q);
        if (flags & 1) { st.keyframes++; if (st.idrAskedAt !== null && st.keyframeAfterAsk === null) st.keyframeAfterAsk = t - st.idrAskedAt; }
        if (flags & 2) st.gaps++;
        if (flags & 8) st.prft++;
        const b = box(u8, 16);
        if (b !== ((flags & 8) ? 'prft' : 'moof')) st.badBox++;
        if (lastSeq !== 0 && seq > lastSeq + 1) st.seqHoles += seq - lastSeq - 1;
        if (seq <= lastSeq) st.late++; else lastSeq = seq;
      }
    } else if (kind === 4) st.kinds.control++;
    else st.bad++;
  };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.reply === 'answer') { st.answer = m.data; pc.setRemoteDescription({ type: 'answer', sdp: m.data }).catch(e => st.errors.push('setRemoteDescription: ' + e.message)); }
    else if (m.reply === 'candidate') pc.addIceCandidate({ candidate: m.data, sdpMid: m.mid }).catch(e => st.errors.push('addIceCandidate: ' + e.message));
    else if (m.reply === 'served') st.served = m;
    else if (m.reply === 'stats') st.stats.push(m.data);
    else st.errors.push(m.reply + ': ' + (m.data || ''));
  };
  pc.onicecandidate = e => { if (e.candidate && ws.readyState === 1) ws.send(JSON.stringify({ req: 'candidate', data: e.candidate.candidate })); };
  pc.oniceconnectionstatechange = () => st.ice.push(pc.iceConnectionState + '@' + now());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('signalling socket failed')); });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ req: 'offer', data: offer.sdp }));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(seconds * 500);
  // A viewer's keyframe request, both ways a page can send it.
  st.idrAskedAt = now();
  if (dc.readyState === 'open') dc.send('{"request":"idr"}');
  if (ws.readyState === 1) ws.send(JSON.stringify({ req: 'idr', data: '' }));
  await sleep(seconds * 500);
  if (st.video) { try { st.videoFrames = st.video.getVideoPlaybackQuality().totalVideoFrames; st.videoSize = st.video.videoWidth + 'x' + st.video.videoHeight; } catch (e) {} st.video = undefined; }
  const rs = await pc.getStats();
  const stats = { pair: null, channel: null, transport: null, sctpMax: pc.sctp ? pc.sctp.maxMessageSize : null };
  rs.forEach(r => {
    if (r.type === 'candidate-pair' && (r.selected || r.nominated) && r.state === 'succeeded') stats.pair = { rtt: r.currentRoundTripTime, bytes: r.bytesReceived, local: r.localCandidateId, remote: r.remoteCandidateId };
    if (r.type === 'data-channel') stats.channel = { state: r.state, messagesReceived: r.messagesReceived, bytesReceived: r.bytesReceived, messagesSent: r.messagesSent };
    if (r.type === 'transport') stats.transport = { dtls: r.dtlsState, ice: r.iceState, selected: r.selectedCandidatePairId };
  });
  rs.forEach(r => { if (stats.pair && r.type === 'local-candidate' && r.id === stats.pair.local) stats.pair.localType = r.candidateType; if (stats.pair && r.type === 'remote-candidate' && r.id === stats.pair.remote) stats.pair.remoteType = r.candidateType; });
  try { dc.close(); pc.close(); ws.close(); } catch (e) {}
  const pct = (a, p) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
  const dur = (lastAt || 0) - (st.firstAt || 0);
  return { ...st, queueMs: { p50: pct(st.queueMs, 0.5), p95: pct(st.queueMs, 0.95), max: pct(st.queueMs, 1) },
    interMs: { p50: pct(st.interMs, 0.5), p95: pct(st.interMs, 0.95), max: pct(st.interMs, 1) },
    fps: dur > 0 ? +(1000 * (st.frames - 1) / dur).toFixed(1) : 0,
    kbps: dur > 0 ? Math.round(8 * st.bytes / dur) : 0,
    answerHasData: !!(st.answer && /^m=application 9 /m.test(st.answer)),
    answerDeclined: !!(st.answer && /^m=application 0 /m.test(st.answer)),
    answerSctpPort: st.answer && (st.answer.match(/^a=sctp-port:(\d+)/m) || [])[1],
    answerMaxMsg: st.answer && (st.answer.match(/^a=max-message-size:(\d+)/m) || [])[1],
    stats: st.stats.slice(-3), rtc: stats, answer: undefined };};
