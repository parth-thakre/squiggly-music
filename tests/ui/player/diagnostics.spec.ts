import { installDesktopBridge } from '../fixtures/desktop';
import { expect, test } from '../fixtures/test';

// The sink line (AudioPath.sink): what the Linux sound server says it runs the sink at, on the
// Diagnostics page, and a note on the deck only when it resamples what mpv sends.
const song = {
  id: 'song-1', title: 'Dawn Chorus', artist: 'The Larks', album: 'Morning', duration: 200, source: 'navidrome',
  sourceFormat: 'flac', sourceSampleRate: 44100, sourceBitDepth: 16, albumId: 'album-1', artistId: 'artist-1', coverArt: null,
};
const sink = { server: 'pipewire', route: 'stream', name: 'Example DAC Analog Stereo', rate: 48000, format: 's32le', channels: 2 };
// The fixture replaces `audio` whole, so every field is here.
const audio = (outputRate: number, resampling: boolean | null, withSink = true, route = 'stream') => ({
  codec: 'flac', decoderRate: 44100, decoderFormat: 's16', decoderChannels: 'stereo', outputRate, outputFormat: 's16',
  outputChannels: 'stereo', outputBackend: 'pipewire', requestedDevice: 'auto', replayGain: 'no', exclusiveRequested: false,
  filters: '', bufferSeconds: 10, streamBytesPerSecond: null, buffering: false, sink: withSink ? { ...sink, route, resampling } : null,
});
const open = (page: import('@playwright/test').Page, playerAudio: object) => installDesktopBridge(page, {
  player: { queue: [song], entryIds: ['entry-1'], currentIndex: 0, duration: 200, audio: playerAudio },
});

test('a resampling server shows on Diagnostics and in the deck\'s line', async ({ page }) => {
  await open(page, audio(44100, true));
  await page.goto('/');
  const deck = page.getByRole('complementary', { name: 'Now playing' });
  await expect(deck.locator('.signal')).toHaveText('FLAC · 44.1 kHz · 16-bit. Resampled by PipeWire.');
  await deck.getByRole('button', { name: 'Diagnostics' }).click();
  const row = page.locator('.facts tr').filter({ has: page.getByRole('rowheader', { name: 'Sink' }) });
  await expect(row).toContainText('Example DAC Analog Stereo');
  await expect(row).toContainText('PipeWire runs the sink at 48 kHz, s32; mpv sends 44.1 kHz, so PipeWire resamples.');
  await expect(page.locator('main')).not.toContainText(/bit-perfect/i);
});

test('a matching sink leaves the deck\'s line alone', async ({ page }) => {
  await open(page, audio(48000, false));
  await page.goto('/');
  const deck = page.getByRole('complementary', { name: 'Now playing' });
  await expect(deck.locator('.signal')).toHaveText('FLAC · 44.1 kHz · 16-bit');
  await deck.getByRole('button', { name: 'Diagnostics' }).click();
  await expect(page.getByText('PipeWire runs the sink at 48 kHz, s32, which matches the rate mpv sends.')).toBeVisible();
});

test('no report, no sink row', async ({ page }) => {
  await open(page, audio(44100, null, false));
  await page.goto('/');
  const deck = page.getByRole('complementary', { name: 'Now playing' });
  await expect(deck.locator('.signal')).toHaveText('FLAC · 44.1 kHz · 16-bit');
  await deck.getByRole('button', { name: 'Diagnostics' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Diagnostics');
  await expect(page.getByText('Handed to')).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'Sink' })).toHaveCount(0);
});

test('a guessed sink says so, and the deck says nothing about resampling', async ({ page }) => {
  await open(page, audio(44100, null, true, 'default'));
  await page.goto('/');
  const deck = page.getByRole('complementary', { name: 'Now playing' });
  await expect(deck.locator('.signal')).toHaveText('FLAC · 44.1 kHz · 16-bit');
  await deck.getByRole('button', { name: 'Diagnostics' }).click();
  const row = page.locator('.facts tr').filter({ has: page.getByRole('rowheader', { name: 'Sink' }) });
  await expect(row).toContainText('PipeWire runs the default sink at 48 kHz, s32. Whether PipeWire resamples isn\'t known: mpv\'s stream wasn\'t found, so it may be playing into another sink.');
  await expect(row).not.toContainText('so PipeWire resamples');
});
