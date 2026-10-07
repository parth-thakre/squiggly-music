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

// A send the test answers when it chooses, so an account can change while one is on its way.
function held(stored: QueuedPlays = { account: 'A', plays: [] }) {
  let account = stored.account ?? '';
  const sent: string[] = [];
  const answers: ((outcome: SendOutcome) => void)[] = [];
  const saved: QueuedPlays[] = [];
  const failed = vi.fn();
  const subject = new PlayReports({
    send: id => { sent.push(`${account}:${id}`); return new Promise<SendOutcome>(resolve => answers.push(resolve)); },
    away: () => false, failed, load: () => stored,
    save: value => saved.push({ account: value.account, plays: [...value.plays] }), changed: () => {}, now: () => 1,
  });
  const answer = async (outcome: SendOutcome) => { await vi.waitFor(() => expect(answers.length).toBeGreaterThan(0)); answers.shift()!(outcome); };
  return { subject, sent, saved, failed, answer, signIn: (key: string) => { account = key; subject.bind(key); } };
}

describe('play reports when the account changes during a send', () => {
  it('never queues one account\'s play for the next', async () => {
    const t = held();
    const report = t.subject.report('a-song', 'finished');
    t.subject.clear();
    t.signIn('B');
    await t.answer('unreachable');
    await report;
    expect(t.subject.size).toBe(0);
    expect(t.saved.at(-1)).toEqual({ account: 'B', plays: [] });
    expect(t.failed).not.toHaveBeenCalled();
    await t.subject.flush();
    expect(t.sent).toEqual(['A:a-song']);
  });
  it('keeps nothing from a send that was on its way when the queue was cleared', async () => {
    const t = held();
    const report = t.subject.report('a-song', 'finished');
    t.subject.clear();
    await t.answer('unreachable');
    await report;
    expect(t.subject.size).toBe(0);
    expect(t.saved).toEqual([]);
  });
  it('stops a flush for the account that was bound when it began', async () => {
    const t = held({ account: 'A', plays: [{ trackId: 'one', at: 1 }, { trackId: 'two', at: 2 }] });
    const flushing = t.subject.flush();
    t.signIn('B');
    await t.answer('sent');
    await flushing;
    expect(t.sent).toEqual(['A:one']);
    expect(t.saved.at(-1)).toEqual({ account: 'B', plays: [] });
    // B's own plays flush on their own, not behind A's.
    t.signIn('B');
    const report = t.subject.report('b-song', 'finished');
    await t.answer('unreachable');
    await report;
    const next = t.subject.flush();
    await t.answer('sent');
    await next;
    expect(t.sent).toEqual(['A:one', 'B:b-song', 'B:b-song']);
    expect(t.subject.size).toBe(0);
  });
});
