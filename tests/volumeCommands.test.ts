import { afterEach, describe, expect, it, vi } from 'vitest';
import { VolumeCommandCoalescer } from '../apps/desktop/renderer/src/volumeCommands';
import type { Result } from '../packages/core/contracts';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function deferred() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>(done => { resolve = done; });
  return { promise, resolve };
}

describe('volume command coalescer', () => {
  it('drains the final value after the tab-scoped subscriber unmounts', async () => {
    vi.useFakeTimers();
    const first = deferred(); const second = deferred();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const commands = new VolumeCommandCoalescer(send, vi.fn());
    const unsubscribe = commands.subscribe(vi.fn());

    commands.enqueue(60);
    await vi.advanceTimersByTimeAsync(80);
    expect(send).toHaveBeenCalledWith(60);
    commands.enqueue(40);
    commands.finish();
    unsubscribe();

    first.resolve({ ok: true, value: undefined });
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls.map(([percent]) => percent)).toEqual([60, 40]);
    second.resolve({ ok: true, value: undefined });
    await vi.advanceTimersByTimeAsync(0);
  });

  it('keeps the committed draft until the matching snapshot arrives', async () => {
    vi.useFakeTimers();
    const commands = new VolumeCommandCoalescer(async () => ({ ok: true, value: undefined }), vi.fn());
    commands.enqueue(45);
    commands.finish();
    await vi.advanceTimersByTimeAsync(0);

    expect(commands.value).toBe(45);
    commands.confirm(100);
    expect(commands.value).toBe(45);
    commands.confirm(45);
    expect(commands.value).toBeNull();
  });

  it('keeps a newer pending value when an in-flight command fails', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ok: true, value: undefined });
    const onError = vi.fn();
    const commands = new VolumeCommandCoalescer(send, onError);
    commands.enqueue(70);
    await vi.advanceTimersByTimeAsync(80);
    commands.enqueue(55);
    commands.finish();

    first.resolve({ ok: false, error: 'device failed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith('device failed');
    expect(commands.value).toBe(55);
    expect(send.mock.calls.map(([percent]) => percent)).toEqual([70, 55]);
  });
});
