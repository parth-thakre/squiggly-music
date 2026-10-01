#!/usr/bin/env node
// Receives a diagnostics build's events (apps/desktop/main/remoteDiagnostics.ts).
//
//   node scripts/diag-collector.mjs --host 100.72.88.79 --port 47800 --token <t> --out <dir>
//
// POST /ingest   JSON array of events, with "authorization: Bearer <token>"
// GET  /health   "ok"
//
// Appends every event to <out>/events.ndjson, keeps the newest heartbeat in
// <out>/latest-heartbeat.json, and prints one line per event (heartbeats at most every 30 s).
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '47800' },
    token: { type: 'string' },
    out: { type: 'string', default: 'diag-out' },
    'heartbeat-every': { type: 'string', default: '30' },
  },
});
if (!values.token) {
  console.error('Usage: node scripts/diag-collector.mjs --host <ip> --port <port> --token <token> --out <dir>');
  process.exit(2);
}
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const eventsPath = join(out, 'events.ndjson');
const heartbeatPath = join(out, 'latest-heartbeat.json');
const expected = Buffer.from(`Bearer ${values.token}`);
const heartbeatEvery = Number(values['heartbeat-every']) * 1000;
const MAX_BODY = 20 * 1024 * 1024;

const authorized = header => {
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
};

// One short line per event ---------------------------------------------------------------

const clip = (text, limit = 220) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};
const rest = event => { const { t: _t, seq: _s, session: _n, kind: _k, ...data } = event; return data; };
const summaries = {
  startup: e => `v${e.app?.version} ${e.os?.platform} ${e.os?.release} ${e.os?.arch} electron ${e.versions?.electron} node ${e.versions?.node} packaged=${e.app?.isPackaged} portable=${e.app?.portable} runtime=${clip(JSON.stringify(e.runtime), 200)}`,
  heartbeat: e => {
    const p = e.player ?? {}, d = e.diagnostics ?? {}, s = e.server ?? {};
    const audio = p.audio ?? {};
    return `engine=${p.engine} playing=${p.playing} idx=${p.currentIndex}/${p.queueLength} dev=${p.selectedDevice}(${p.deviceCount}) out=${audio.outputRate ?? '-'}/${audio.outputFormat ?? '-'} ${audio.outputBackend ?? ''}`
      + ` err=${clip(p.error, 60) || '-'} server=${s.connected ? 'on' : 'off'}${s.reconnectError ? `(${clip(s.reconnectError, 40)})` : ''} update=${e.update?.status}`
      + ` loop=${Number(d.eventLoopDelayMs ?? 0).toFixed(1)}ms queued=${e.diag?.queued} dropped=${e.diag?.dropped}`;
  },
  'main.console': e => `[${e.level}] ${clip(e.text)}`,
  'renderer.console': e => `${e.window} [${e.level}] ${clip(e.message, 180)} (${clip(e.source, 60)}:${e.line})`,
  'main.uncaught': e => `${e.origin}: ${clip(e.message)} ${clip(e.stack?.split('\n')[1], 100)}`,
  'main.rejection': e => `${clip(e.message)} ${clip(e.stack?.split('\n')[1], 100)}`,
  'host.spawn': e => `pid=${e.pid} exec=${e.execPath} (${e.execPathExists ? 'exists' : e.fromPath ? 'PATH' : 'MISSING'}) script=${e.scriptExists ? 'ok' : 'MISSING'} libmpv=${e.libmpv ?? '-'}${e.libmpv ? (e.libmpvExists ? ' ok' : ' MISSING') : ''}`,
  'host.spawned': e => `pid=${e.pid}`,
  'host.error': e => `pid=${e.pid} ${e.code ?? ''} ${clip(e.message)}`,
  'host.exit': e => `pid=${e.pid} code=${e.code} signal=${e.signal}`,
  'host.stderr': e => clip(e.line),
  'host.stdout': e => clip(e.line),
  'host.state': e => `${e.previousEngine ?? '∅'} → ${e.engine}${e.error ? ` error=${clip(e.error, 160)}` : ''} devices=${e.deviceCount}`,
  'ipc.error': e => `${e.channel} ${e.ms}ms ${clip(e.error, 180)}`,
  'ipc.counts': e => Object.entries(e.calls ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(' ')
    + (Object.keys(e.failures ?? {}).length ? ` | failures ${Object.entries(e.failures).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''),
  'renderer.gone': e => `${e.window} reason=${e.reason} exit=${e.exitCode}`,
  'chromium.child-gone': e => `${e.type} ${e.name ?? ''} reason=${e.reason} exit=${e.exitCode}`,
  'renderer.load-failed': e => `${e.window} ${e.code} ${e.description} ${clip(e.url, 100)}`,
  'renderer.preload-error': e => `${e.window} ${clip(e.message)}`,
  'ext.list': e => (e.extensions ?? []).map(x => `${x.id}@${x.version}${x.enabled ? '' : '(off)'}${x.error ? '!' : ''}`).join(' ') || '(none)',
  'ext.change': e => `${e.id} ${e.change}${e.error ? `: ${clip(e.error, 160)}` : ''}`,
  'diag.note': e => clip(e.message, 300),
};
const summary = event => {
  const known = summaries[event.kind];
  try { if (known) return known(event); } catch { /* Fall through to the raw data. */ }
  return clip(JSON.stringify(rest(event)), 220);
};
const clock = t => { const date = new Date(t); return Number.isNaN(date.getTime()) ? String(t) : date.toISOString().slice(11, 23); };

let lastSession = null;
let lastHeartbeatPrinted = 0;
function print(event) {
  if (event.session !== lastSession) {
    lastSession = event.session;
    console.log(`──── session ${event.session} ────`);
  }
  if (event.kind === 'heartbeat') {
    if (Date.now() - lastHeartbeatPrinted < heartbeatEvery) return;
    lastHeartbeatPrinted = Date.now();
  }
  console.log(`${clock(event.t)} ${String(event.kind).padEnd(20)} ${summary(event)}`);
}

// Server ----------------------------------------------------------------------------------

let writes = Promise.resolve();
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://collector');
  const reply = (status, body = '') => { response.writeHead(status, { 'content-type': 'text/plain' }); response.end(body); };
  if (request.method === 'GET' && url.pathname === '/health') return reply(200, 'ok\n');
  if (url.pathname !== '/ingest') return reply(404, 'not found\n');
  if (request.method !== 'POST') return reply(405, 'POST only\n');
  if (!authorized(request.headers.authorization)) { request.resume(); return reply(401, 'bad token\n'); }
  const chunks = [];
  let size = 0;
  request.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY) { reply(413, 'too large\n'); request.destroy(); return; }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (size > MAX_BODY) return;
    let events;
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      events = (Array.isArray(parsed) ? parsed : [parsed]).filter(event => event && typeof event === 'object');
    } catch { return reply(400, 'invalid JSON\n'); }
    const received = new Date().toISOString();
    const lines = events.map(event => JSON.stringify({ ...event, receivedAt: received })).join('\n');
    if (lines) writes = writes.then(() => appendFile(eventsPath, `${lines}\n`)).catch(error => console.error(`Could not append to ${eventsPath}: ${error.message}`));
    for (const event of events) {
      if (event.kind === 'heartbeat') {
        try { writeFileSync(`${heartbeatPath}.tmp`, JSON.stringify(event, null, 2)); renameSync(`${heartbeatPath}.tmp`, heartbeatPath); }
        catch (error) { console.error(`Could not write ${heartbeatPath}: ${error.message}`); }
      }
      print(event);
    }
    reply(204);
  });
  request.on('error', () => undefined);
});
server.on('error', error => { console.error(`Collector could not listen on ${values.host}:${values.port}: ${error.message}`); process.exit(1); });
server.listen(Number(values.port), values.host, () => {
  console.log(`Collecting on http://${values.host}:${values.port}/ingest → ${out}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); void writes.then(() => process.exit(0)); });
