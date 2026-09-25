import { defineExtension } from '@squiggly/extension-api';

// "Song by Artist, from Album". The format is a setting: {title}, {artist}, and {album} are filled in.
export default defineExtension({
  activate(ctx) {
    ctx.commands.register({
      id: 'copy',
      title: 'Copy the song that’s playing',
      keys: ['ctrl+shift+c'],
      when: () => ctx.player.current() !== null,
      async run() {
        const track = ctx.player.current();
        if (!track) return;
        const format = ctx.settings.get('format', '{title} by {artist}, from {album}');
        const text = format.replace(/\{(title|artist|album)\}/g, (_match: string, field: 'title' | 'artist' | 'album') => track[field] || '');
        await ctx.clipboard.writeText(text);
        ctx.notify(`Copied “${text}”.`);
      },
    });
  },
});
