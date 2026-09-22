import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { SubsonicClient } from '../packages/adapter-opensubsonic/client';
import { Metrics } from '../packages/core/metrics';

it.each(['/music', '/app', '/rest', '/music/app', '/music/rest'])('connects, browses and streams with server base path %s', async basePath => {
  const password = 'fixture-password';
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const params = request.method === 'POST' ? new URLSearchParams(Buffer.concat(chunks).toString()) : url.searchParams;
    const reply = (payload: object) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ 'subsonic-response': {
        status: 'ok', version: '1.16.1', type: 'navidrome', serverVersion: '0.63.2', openSubsonic: true, ...payload,
      } }));
    };
    const token = createHash('md5').update(password + params.get('s')).digest('hex');
    if (params.get('u') !== 'listener' || params.get('t') !== token || params.has('p')) {
      reply({ status: 'failed', error: { code: 40, message: 'Wrong username or password' } });
      return;
    }
    requests.push(url.pathname);
    if (url.pathname === `${basePath}/rest/ping.view`) reply({});
    else if (url.pathname === `${basePath}/rest/getAlbumList2.view`) {
      if (params.get('size') !== '48' || params.get('type') !== 'newest') { response.writeHead(400).end(); return; }
      reply({ albumList2: { album: params.get('offset') === '0' ? [{ id: 'a1', name: 'Record', artist: 'Artist', songCount: 1 }] : [] } });
    } else if (url.pathname === `${basePath}/rest/getAlbum.view` && params.get('id') === 'a1') {
      reply({ album: { id: 'a1', name: 'Record', artist: 'Artist', song: [
        { id: 'song & 1', title: 'First track', suffix: 'flac', samplingRate: 96000, bitDepth: 24, duration: 180 },
      ] } });
    } else if (url.pathname === `${basePath}/rest/stream.view` && params.get('id') === 'song & 1' && params.get('format') === 'raw') {
      response.setHeader('Content-Type', 'audio/flac');
      response.end('fLaC-fixture');
    } else response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const connection = { url: `http://127.0.0.1:${address.port}${basePath}`, username: 'listener', password };
    const client = new SubsonicClient(connection, new Metrics());
    expect(await Effect.runPromise(client.ping())).toEqual({ name: 'Navidrome' });
    expect(await Effect.runPromise(client.albums(0))).toEqual([{ id: 'a1', name: 'Record', artist: 'Artist', songCount: 1 }]);
    expect(await Effect.runPromise(client.albums(48))).toEqual([]);
    const [item] = await Effect.runPromise(client.albumQueue('a1'));
    expect(item.track).toMatchObject({ source: 'navidrome', album: 'Record', artist: 'Artist', sourceSampleRate: 96000, sourceBitDepth: 24 });
    const stream = await fetch(item.location);
    expect(stream.status).toBe(200);
    expect(await stream.text()).toBe('fLaC-fixture');
    expect(JSON.stringify(item.track)).not.toMatch(/fixture-password|127\.0\.0\.1|t=/);
    expect(requests).toEqual(['ping', 'getAlbumList2', 'getAlbumList2', 'getAlbum', 'stream'].map(endpoint => `${basePath}/rest/${endpoint}.view`));
    await expect(Effect.runPromise(new SubsonicClient({ ...connection, password: 'wrong' }, new Metrics()).ping())).rejects.toThrow('Incorrect username or password');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
