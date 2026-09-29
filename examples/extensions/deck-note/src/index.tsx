import { defineExtension, type DeckSlotProps } from '@squiggly/extension-api';

// The year the playing song came out, on the deck's quiet line beside the signal path, and in
// the mini player. A song without a year shows nothing rather than a guess. Songs don't carry a
// bitrate, so the year is what there is to show.
//
// The slot is handed the song. For the rest of the player's state, call ctx.player.use inside
// the component: it re-renders only when the value picked out changes.
export default defineExtension({
  activate(ctx) {
    ctx.deck.register({ id: 'year', placement: 'quiet-line', component: Year });
  },
});

function Year({ track }: DeckSlotProps) {
  if (!track.year) return null;
  return <span>From {track.year}.</span>;
}
