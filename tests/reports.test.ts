import { describe, expect, it, vi } from 'vitest';
import { MAX_QUEUED_PLAYS, PlayReports, queuePlay, type QueuedPlays, type SendOutcome } from '../packages/core/plays';

function reports(outcomes: SendOutcome[] = [], stored: QueuedPlays = { account: 'k', plays: [] }) {
  let away = false, now = 1000;
  const sent: { id: string; event: string; at?: number }[] = [];
  const saved: QueuedPlays[] = [];
  const counts: number[] = [];
  const failed = vi.fn();
  const subject = new PlayReports({
    send: async (id, event, at) => { sent.push({ id, event, ...(at !== undefined ? { at } : {}) }); return outcomes.shift() ?? 'sent'; },
    away: () => away, failed, load: () => stored,
    save: value => saved.push({ account: value.account, plays: [...value.plays] }), changed: count => counts.push(count), now: () => now,
  });
  return { subject, sent, saved, counts, failed, setAway: (value: boolean) => { away = value; }, tick: (ms: number) => { now += ms; }, outcomes };
}

describe('play reports while the server is away', () => {
  it('bounds the queue, keeps its order, and skips exact duplicates', () => {
    let queue = queuePlay([], { trackId: 'a', at: 1 });
    queue = queuePlay(queue, { trackId: 'a', at: 1 });
    queue = queuePlay(queue, { trackId: 'a', at: 2 });
    expect(queue).toEqual([{ trackId: 'a', at: 1 }, { trackId: 'a', at: 2 }]);
    for (let i = 0; i < MAX_QUEUED_PLAYS + 10; i++) queue = queuePlay(queue, { trackId: `t${i}`, at: 100 + i });
    expect(queue).toHaveLength(MAX_QUEUED_PLAYS);
    expect(queue[0]).toEqual({ trackId: 't10', at: 110 });
    expect(queue.at(-1)).toEqual({ trackId: `t${MAX_QUEUED_PLAYS + 9}`, at: 100 + MAX_QUEUED_PLAYS + 9 });
  });
  it('skips now playing while away, and queues a finished play with when it finished', async () => {
    const { subject, sent, setAway, saved } = reports();
    setAway(true);
    await subject.report('a', 'started');
    await subject.report('a', 'finished');
    expect(sent).toEqual([]);
    expect(subject.size).toBe(1);
    expect(saved.at(-1)).toEqual({ account: 'k', plays: [{ trackId: 'a', at: 1000 }] });
  });
  it('queues a finished play that got no answer and asks about the server; drops a refused one', async () => {
    const { subject, failed } = reports(['unreachable', 'refused']);
    await subject.report('a', 'finished');
    expect(subject.size).toBe(1);
    expect(failed).toHaveBeenCalledOnce();
    await subject.report('b', 'finished');
    expect(subject.size).toBe(1);
  });
  it('drops now playing that got no answer, and asks about the server', async () => {
    const { subject, failed } = reports(['unreachable']);
    await subject.report('a', 'started');
    expect(subject.size).toBe(0);
    expect(failed).toHaveBeenCalledOnce();
  });
  it('sends oldest first with each play\'s own time, stops at no answer, and drops refused plays', async () => {
    const { subject, sent, failed, setAway, tick, outcomes } = reports();
    setAway(true);
    for (const id of ['a', 'b', 'c', 'd']) { await subject.report(id, 'finished'); tick(10); }
    setAway(false);
    outcomes.push('sent', 'refused', 'unreachable');
    await subject.flush();
    expect(sent).toEqual([{ id: 'a', event: 'finished', at: 1000 }, { id: 'b', event: 'finished', at: 1010 }, { id: 'c', event: 'finished', at: 1020 }]);
    expect(subject.size).toBe(2);
    expect(failed).toHaveBeenCalledOnce();
    await subject.flush();
    expect(sent.slice(3)).toEqual([{ id: 'c', event: 'finished', at: 1020 }, { id: 'd', event: 'finished', at: 1030 }]);
    expect(subject.size).toBe(0);
  });
  it('never flushes while away', async () => {
    const { subject, sent } = reports([], { account: 'k', plays: [{ trackId: 'a', at: 5 }] });
    const away = reports([], { account: 'k', plays: [{ trackId: 'a', at: 5 }] });
    away.setAway(true);
    await away.subject.flush();
    expect(away.sent).toEqual([]);
    await subject.flush();
    expect(sent).toEqual([{ id: 'a', event: 'finished', at: 5 }]);
  });
  it('flushes the queue after a live report goes through', async () => {
    const { subject, sent } = reports([], { account: 'k', plays: [{ trackId: 'old', at: 5 }] });
    await subject.report('new', 'finished');
    await vi.waitFor(() => expect(subject.size).toBe(0));
    expect(sent.map(item => item.id)).toEqual(['new', 'old']);
  });
  it('forgets another account\'s plays, and saves after every change', () => {
    const { subject, saved, counts } = reports([], { account: 'k', plays: [{ trackId: 'a', at: 5 }] });
    subject.bind('k');
    expect(subject.size).toBe(1);
    subject.bind('other');
    expect(subject.size).toBe(0);
    expect(saved.at(-1)).toEqual({ account: 'other', plays: [] });
    expect(counts.at(-1)).toBe(0);
  });
});
