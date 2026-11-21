import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { expect, test } from '@playwright/test';

// Verifies every <video> clip on site/index.html:
// - progressive MP4 (moov box before mdat, no moof fragments)
// - decodes at the exact width/height declared in site/index.html
// - finite duration within a sensible loop range (2s to 25s)
// - neither the right band nor bottom band of decoded frames is solid black (catches crop/scale bugs)

const SITE = join(process.cwd(), 'site');
const ORIGIN = 'https://squiggly.test';
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
};

function topLevelBoxes(buf: Buffer): string[] {
  const names: string[] = [];
  for (let offset = 0; offset + 8 <= buf.length;) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (size === 0) size = buf.length - offset;
    else if (size === 1) {
      if (offset + 16 > buf.length) break;
      size = Number(buf.readBigUInt64BE(offset + 8));
    }
    names.push(type);
    if (size < 8) break;
    offset += size;
  }
  return names;
}

test('every site clip is a progressive MP4 with valid dimensions, duration, and framing', async ({ page }) => {
  await page.route('https://api.github.com/**', route => route.abort());
  await page.route(`${ORIGIN}/**`, async route => {
    const reqPath = normalize(new URL(route.request().url()).pathname);
    const file = join(SITE, reqPath === '/' ? 'index.html' : reqPath);
    if (!file.startsWith(SITE)) return route.fulfill({ status: 404 });
    try {
      const body = await readFile(file);
      await route.fulfill({
        status: 200,
        contentType: TYPES[extname(file)] ?? 'application/octet-stream',
        body,
      });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });

  await page.goto(`${ORIGIN}/`);
  const clips = await page.locator('video').evaluateAll(videos =>
    videos.map(v => ({
      src: v.getAttribute('src') ?? '',
      width: Number(v.getAttribute('width')),
      height: Number(v.getAttribute('height')),
    })),
  );
  expect(clips.length).toBeGreaterThanOrEqual(13);

  for (const clip of clips) {
    const bytes = await readFile(join(SITE, clip.src));
    const boxes = topLevelBoxes(bytes);
    const moovIdx = boxes.indexOf('moov');
    const mdatIdx = boxes.indexOf('mdat');
    expect(boxes, `${clip.src} must be progressive (no moof fragments)`).not.toContain('moof');
    expect(moovIdx, `${clip.src} must have a moov atom`).toBeGreaterThanOrEqual(0);
    expect(mdatIdx, `${clip.src} must have an mdat atom`).toBeGreaterThanOrEqual(0);
    expect(moovIdx, `${clip.src} must place moov before mdat (+faststart)`).toBeLessThan(mdatIdx);
  }

  const results = await page.evaluate(async (items) => {
    const sampleBlackRatio = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
      const data = ctx.getImageData(x, y, w, h).data;
      let black = 0;
      const total = w * h;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] <= 4 && data[i + 1] <= 4 && data[i + 2] <= 4) black++;
      }
      return black / total;
    };

    const out: Array<{
      src: string;
      videoWidth: number;
      videoHeight: number;
      duration: number;
      rightBlackStart: number;
      bottomBlackStart: number;
      rightBlackMid: number;
      bottomBlackMid: number;
    }> = [];

    for (const item of items) {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.src = item.src;
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error(`Failed to load ${item.src}`));
      });

      const seekTo = async (t: number) => {
        video.currentTime = t;
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          video.addEventListener('seeked', done, { once: true });
        });
      };

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d')!;
      const rw = Math.max(1, Math.floor(canvas.width * 0.25));
      const bh = Math.max(1, Math.floor(canvas.height * 0.25));

      await seekTo(0.05);
      ctx.drawImage(video, 0, 0);
      const rightBlackStart = sampleBlackRatio(ctx, canvas.width - rw, 0, rw, canvas.height);
      const bottomBlackStart = sampleBlackRatio(ctx, 0, canvas.height - bh, canvas.width, bh);

      const mid = Number.isFinite(video.duration) && video.duration > 0.5 ? video.duration * 0.5 : 0.25;
      await seekTo(mid);
      ctx.drawImage(video, 0, 0);
      const rightBlackMid = sampleBlackRatio(ctx, canvas.width - rw, 0, rw, canvas.height);
      const bottomBlackMid = sampleBlackRatio(ctx, 0, canvas.height - bh, canvas.width, bh);

      out.push({
        src: item.src,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        duration: video.duration,
        rightBlackStart,
        bottomBlackStart,
        rightBlackMid,
        bottomBlackMid,
      });
    }
    return out;
  }, clips);

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const r = results[i];
    expect(r.videoWidth, `${clip.src} width`).toBe(clip.width);
    expect(r.videoHeight, `${clip.src} height`).toBe(clip.height);
    expect(Number.isFinite(r.duration), `${clip.src} finite duration`).toBe(true);
    expect(r.duration, `${clip.src} min duration`).toBeGreaterThanOrEqual(2);
    expect(r.duration, `${clip.src} max duration`).toBeLessThanOrEqual(25);
    expect(r.rightBlackStart, `${clip.src} right edge black at start`).toBeLessThan(0.25);
    expect(r.bottomBlackStart, `${clip.src} bottom edge black at start`).toBeLessThan(0.25);
    expect(r.rightBlackMid, `${clip.src} right edge black at midpoint`).toBeLessThan(0.25);
    expect(r.bottomBlackMid, `${clip.src} bottom edge black at midpoint`).toBeLessThan(0.25);
  }
});
