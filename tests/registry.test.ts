import { describe, expect, it } from 'vitest';
import { registry, RegistryCollision, type MenuTarget } from '../apps/desktop/renderer/src/app/registry';

const target: MenuTarget = { kind: 'playlist', playlist: { id: 'p', name: 'P', comment: null, owner: null, songCount: 0, duration: 0, coverArt: null, readonly: false, changed: null } };
const ids = () => registry.menu.for(target).map(item => item.id);

describe('extension registry', () => {
  it('namespaces ids by owner', () => {
    const scope = registry.scope('names');
    scope.menu({ id: 'play', section: 0, label: 'Play' });
    scope.command({ id: 'go', title: 'Go', run() {} });
    expect(ids()).toContain('names:play');
    expect(registry.commands.get('names:go')?.owner).toBe('names');
    expect(() => scope.menu({ id: 'other:play', section: 0, label: 'x' })).toThrow();
    expect(() => registry.scope('Bad Owner')).toThrow();
    scope.dispose();
  });

  it('makes disposers idempotent: a second call never removes another item', () => {
    const first = registry.menu.add({ id: 'twice-a', section: 0, label: 'A' }, 'twice');
    registry.menu.add({ id: 'twice-b', section: 0, label: 'B' }, 'twice');
    first(); first();
    expect(ids()).not.toContain('twice:twice-a');
    expect(ids()).toContain('twice:twice-b');
  });

  it('refuses collisions and never lets an old disposer remove its replacement', () => {
    const old = registry.commands.add({ id: 'same', title: 'Old', run() {} }, 'swap');
    expect(() => registry.commands.add({ id: 'same', title: 'New', run() {} }, 'swap')).toThrow(RegistryCollision);
    old();
    registry.commands.add({ id: 'same', title: 'New', run() {} }, 'swap');
    old();
    expect(registry.commands.get('swap:same')?.title).toBe('New');

    const oldItem = registry.menu.add({ id: 'same', section: 0, label: 'Old' }, 'swap');
    expect(() => registry.menu.add({ id: 'same', section: 0, label: 'New' }, 'swap')).toThrow(RegistryCollision);
    oldItem();
    registry.menu.add({ id: 'same', section: 0, label: 'New' }, 'swap');
    oldItem();
    expect(registry.menu.for(target).find(item => item.id === 'swap:same')?.label).toBe('New');
  });

  it('disposes a whole extension at once, and only its own contributions', () => {
    const extension = registry.scope('ext');
    const own = extension.menu({ id: 'a', section: 1, label: 'A' });
    extension.menu({ id: 'b', section: 1, label: 'B' });
    extension.command({ id: 'c', title: 'C', run() {} });
    const other = registry.scope('neighbour');
    other.menu({ id: 'a', section: 1, label: 'A' });
    own();
    extension.dispose(); extension.dispose();
    expect(ids().filter(id => id.startsWith('ext:'))).toEqual([]);
    expect(registry.commands.get('ext:c')).toBeUndefined();
    expect(ids()).toContain('neighbour:a');
    other.dispose();
  });

  it('hides and reports an item whose predicate throws', () => {
    const scope = registry.scope('broken');
    scope.menu({ id: 'bad', section: 0, label: 'Bad', when() { throw new Error('nope'); } });
    scope.menu({ id: 'good', section: 0, label: 'Good' });
    const errors: string[] = [];
    const found = registry.menu.for(target, (item, error) => errors.push(`${item.id}: ${(error as Error).message}`)).map(item => item.id);
    expect(found).toContain('broken:good');
    expect(found).not.toContain('broken:bad');
    expect(errors).toEqual(['broken:bad: nope']);
    scope.dispose();
  });
});
