import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Reachability } from '../packages/core/contracts';
import { PASSIVE_GAP, PROBE_EVERY, Reach, type ProbeOutcome } from '../packages/core/reach';

afterEach(() => { vi.useRealTimers(); });

// A probe the test answers by hand.
function harness() {
  vi.useFakeTimers();
  const answers: ((outcome: ProbeOutcome) => void)[] = [];
  const states: Reachability[] = [];
  const returned = vi.fn(), refused = vi.fn();
  const probe = vi.fn(() => new Promise<ProbeOutcome>(resolve => answers.push(resolve)));
  const reach = new Reach({ probe, changed: state => states.push(state), returned, refused });
  const answer = async (outcome: ProbeOutcome) => { answers.shift()!(outcome); await vi.advanceTimersByTimeAsync(0); };
  return { reach, probe, states, returned, refused, answer, answers };
}

describe('whether the server answers', () => {
  it('starts one confirming probe however many calls fail at once', async () => {
    const { reach, probe } = harness();
    for (let i = 0; i < 10; i++) reach.failed();
    expect(probe).toHaveBeenCalledOnce();
    expect(reach.state).toMatchObject({ away: false, checking: true });
  });
  it('stays online when the probe is answered, even with a refusal', async () => {
    const { reach, answer } = harness();
    reach.failed();
    await answer({ kind: 'answered' });
    expect(reach.state).toMatchObject({ away: false, checking: false });
    reach.failed();
    await answer({ kind: 'refused', error: 'no' });
    expect(reach.state.away).toBe(false);
  });
  it('goes away, since then, only when the probe gets no answer, and probes every 30 seconds', async () => {
    const { reach, probe, answer } = harness();
    const now = Date.now();
    reach.failed();
    await answer({ kind: 'unreachable' });
    expect(reach.state).toEqual({ away: true, since: now, checking: false, checkedAt: now });
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PROBE_EVERY);
    expect(probe).toHaveBeenCalledTimes(2);
    await answer({ kind: 'unreachable' });
    await vi.advanceTimersByTimeAsync(PROBE_EVERY);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(reach.state.since).toBe(now);
  });
  it('sets no timer while online', async () => {
    const { reach, probe } = harness();
    await vi.advanceTimersByTimeAsync(PROBE_EVERY * 5);
    expect(probe).not.toHaveBeenCalled();
    expect(reach.state.away).toBe(false);
  });
  it('comes back when a probe is answered, and says so once', async () => {
    const { reach, returned, answer, probe } = harness();
    reach.failed();
    await answer({ kind: 'unreachable' });
    await vi.advanceTimersByTimeAsync(PROBE_EVERY);
    await answer({ kind: 'answered', name: 'Navidrome' });
    expect(reach.state).toMatchObject({ away: false, since: null, checking: false });
    expect(returned).toHaveBeenCalledOnce();
    expect(returned).toHaveBeenCalledWith({ kind: 'answered', name: 'Navidrome' });
    await vi.advanceTimersByTimeAsync(PROBE_EVERY * 3);
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it('joins a probe on its way, and skips a passive retry made too soon', async () => {
    const { reach, probe, answer } = harness();
    expect(await reach.retry()).toBeNull();
    reach.failed();
    await answer({ kind: 'unreachable' });
    const first = reach.retry();
    const second = reach.retry();
    expect(probe).toHaveBeenCalledTimes(2);
    await answer({ kind: 'unreachable' });
    expect(await first).toEqual({ kind: 'unreachable' });
    expect(await second).toEqual({ kind: 'unreachable' });
    expect(await reach.retry(true)).toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PASSIVE_GAP);
    void reach.retry(true);
    expect(probe).toHaveBeenCalledTimes(3);
  });
  it('tells the host when a probe while away is refused, and stays away', async () => {
    const { reach, refused, answer } = harness();
    reach.enter();
    await vi.advanceTimersByTimeAsync(PROBE_EVERY);
    await answer({ kind: 'refused', error: 'Incorrect username or password.' });
    expect(refused).toHaveBeenCalledWith('Incorrect username or password.');
    expect(reach.state.away).toBe(true);
  });
  it('ignores a probe that settles after leave()', async () => {
    const { reach, answer, returned, states } = harness();
    reach.enter({ probeNow: true });
    reach.leave();
    const count = states.length;
    await answer({ kind: 'answered' });
    expect(returned).not.toHaveBeenCalled();
    expect(states).toHaveLength(count);
    expect(reach.state.away).toBe(false);
  });
  it('probes at once on entering with probeNow, and after 30 seconds without', async () => {
    const first = harness();
    first.reach.enter({ probeNow: true });
    expect(first.probe).toHaveBeenCalledOnce();
    first.reach.dispose();
    const second = harness();
    second.reach.enter();
    expect(second.probe).not.toHaveBeenCalled();
    expect(second.reach.state.away).toBe(true);
    await vi.advanceTimersByTimeAsync(PROBE_EVERY);
    expect(second.probe).toHaveBeenCalledOnce();
  });
  it('reports only real changes', async () => {
    const { reach, states } = harness();
    reach.leave(); reach.leave();
    expect(states).toEqual([]);
  });
});
