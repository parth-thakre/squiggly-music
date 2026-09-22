# Five more UI directions

These are the second set of isolated design studies for Squiggly's desktop player. Open `/mocks-2.html` on the browser preview server. The first set (Cove, Daylight, After hours, Studio, Blue note) is described in `docs/ui-mockups.md` and lives on its own branch until both are merged, so the "Studies 1–5" link only resolves when that branch is checked out too. The existing player is unchanged. Records, queue entries, lyrics, and progress are sample content. No audio plays, and no device or signal measurement is invented.

## Design plan

The first set explored browsing, collecting, focused listening, queue management, and discovery. This set covers the jobs it left out: reading lyrics, inspecting the audio path, reading one album, controlling playback from a small window, and reaching a song in a very large library. Each study keeps the code-drawn sample sleeves, the squiggly progress line, an accessible transport, and the shared queue and audio-path panels.

| Direction | Palette | Typography | Layout and principle |
| --- | --- | --- | --- |
| Verse | Stone `#e6e8e1`, panel `#dcdfd6`, ink `#1f2421`, moss `#3d6a4d`, marker yellow `#f1cf45` | Georgia lyrics, Arial controls | A narrow record column beside a scrolling lyric sheet. The current word carries the only color. Clicking a line seeks to it. |
| Bench | Graph paper `#f7f9fc`, grid `#dbe3ee`, navy `#1c2b4d`, orange `#e0742a`, white panels | Arial, tabular numerals | The signal chain is the home screen. One dashed orange line marks where Squiggly stops being able to verify anything. Every value reads "Not connected", "Not verified", or "Appears when connected". |
| Sleeve notes | Eight dark tints, one per record, each with a pale accent taken from its sleeve | Georgia album title, Arial controls | An album page: big sleeve, title, liner note, tracklist, and a small shelf. Choosing another record recolors the whole window. |
| Transistor | Desk `#d6d3cb`, radio yellow `#e9b949`, black `#161616`, paper `#fffaf0` | Trebuchet track title, Arial controls | Two compact windows drawn at real pixel sizes: a 380-wide mini player and a 440 by 64 strip in dark and light. For when another app owns the screen. |
| Ledger | Charcoal `#24272c`, panel `#2b2f35`, pale text `#e7e5de`, olive `#b5bd6e` | Arial 12px throughout, tabular numerals | Genre, artist, and album columns above a dense 28px-row track table. Arrow keys move, Enter plays, and `/` focuses the filter. |

```text
Verse             Bench              Sleeve notes       Transistor         Ledger
record | lyrics   player | chain     sleeve | album      mini   | strips    genres artists albums
bottom transport  status panels      tracks | shelf      (real sizes)       track table
                                     bottom player                          status, slim transport
```

## Review before implementation

Bench is the most product-specific study. It treats "unknown" as a designed state rather than an empty one, which is what the handoff rules ask for. If it goes forward, the boundary line and its wording should be kept exactly, and no stage should ever fill in a plausible default.

Sleeve notes depends on extracting a tint from artwork. That belongs in the main process or a worker with a cached result per album, not in the renderer.

Transistor is a window-management question as much as a visual one. The "Keep on top" switch and the "Full window" button imply Electron window modes that do not exist yet.

Ledger is the only study that would meet the 100k-track goal as drawn, and only if the table and the three columns are virtualized. The sample here has 32 rows.

Verse assumes word-level timing. Navidrome's `songLyrics` gives line timing at best, so the current-word marker needs a provider that supplies it or should fall back to line highlighting.

Copy in every study stays functional and in sentence case. There are no bit-perfect or hi-res badges anywhere.

## Preview interactions

Use the numbered direction buttons or a `?view=` URL to switch studies. Verse lines seek to sample positions. Sleeve notes recolors with the selected record and keeps a local row selection. Transistor shares playback state across both window forms. Ledger filters sample rows by genre, artist, album, and text, and supports ArrowUp, ArrowDown, Enter, and `/` in its track table. The queue and audio-path panels open from each study. Reloading clears every mock interaction.
