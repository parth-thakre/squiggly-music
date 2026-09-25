import { defineExtension } from '@squiggly/extension-api';

// Pauses after a set number of minutes (a setting, 30 by default), or when the current song ends.
export default defineExtension({
  activate(ctx) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopWatching: (() => void) | undefined;
    const cancel = () => { clearTimeout(timer); timer = undefined; stopWatching?.(); stopWatching = undefined; };

    const sleep = async (reason: string) => {
      cancel();
      await ctx.player.pause();
      ctx.notify(`Paused ${reason}. Good night.`);
    };

    ctx.commands.register({
      id: 'start',
      title: 'Start the sleep timer',
      run() {
        const minutes = ctx.settings.get('minutes', 30);
        cancel();
        timer = setTimeout(() => void sleep(`after ${minutes} minutes`), minutes * 60_000);
        ctx.notify(`Pausing in ${minutes} minutes.`);
      },
    });

    ctx.commands.register({
      id: 'end-of-song',
      title: 'Pause at the end of this song',
      when: () => ctx.player.current() !== null,
      run() {
        cancel();
        const entry = ctx.player.get().entryIds[ctx.player.get().index];
        // The entry changes when the next song starts; that's the moment to pause.
        stopWatching = ctx.player.select(state => state.entryIds[state.index], next => {
          if (next !== entry) void sleep('at the end of the song');
        });
        ctx.notify('Pausing when this song ends.');
      },
    });

    ctx.commands.register({
      id: 'cancel',
      title: 'Cancel the sleep timer',
      when: () => timer !== undefined || stopWatching !== undefined,
      run() { cancel(); ctx.notify('Sleep timer cancelled.'); },
    });

    // Right-click the song that's playing: "Pause after this song".
    ctx.menus.register({
      id: 'pause-after',
      label: 'Pause after this song',
      when: target => target.kind === 'tracks' && target.tracks.length === 1 && target.tracks[0].id === ctx.player.current()?.id,
      run: () => ctx.commands.execute('sleep-timer:end-of-song'),
    });

    // Anything still pending stops with the extension (turned off, removed, or reloaded).
    return cancel;
  },
});
