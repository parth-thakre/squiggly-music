# Features

Everything Squiggly does, in more detail than the README has room for.

## Library

- Browse records, artists, tracks, genres, playlists, and favorites on your server, or play files from your computer. Records filter by decade (grouped by year), record pages include liner notes and multi-disc tracklists, and artist pages show ranked most-played songs, chronological discographies, an All songs view, and similar artists when the server has them.
- Home has a lead record for what you played last, Most played and Played lately side by side, New arrivals, your automatic playlists, and what other people on the server are playing. The wordmark and G then H go back to it.
- Rate songs, records, and artists from one to five stars, and list the records and tracks you rate highest.
- Search the library from the bar. All shows a few artists, records, and songs, and See all lists the rest of one kind. Enter goes to the first result, Escape goes back, and the searches you used wait under the empty field.
- Build automatic playlists by genre, by decade, and from what's new, all on one Mixes page (G then M).

## Playing

- Edit the queue and your playlists. The queue follows you between devices through the server.
- Drag records, artists, songs, and playlists onto the queue or a playlist, and drop audio files from your computer onto the desktop app's window to play them.
- Repeat the queue or one song, and shuffle what's left to play (`r` and `s`).
- Start a radio station from any song, record, or artist.
- With autoplay on (Settings, off at first), up to ten songs like the last one join the queue as the song before it starts, early enough for a slow server. When the server knows nothing like it, they come from its genre, or from anywhere on the server.
- Listen to the internet radio stations your server lists, from the Playlists page. On the desktop, the line under the station says what it's playing when the station says.
- Star the playing song from the controls or with F. G then C opens its record, and G then . its artist.
- Set a sleep timer from Ctrl+K. It pauses in 15, 30, or 60 minutes, or after this song.
- Export a playlist or the queue as an M3U file, and share songs, records, and playlists as public links when the server allows sharing.

## Sound

Squiggly doesn't do EQ, crossfade, or loudness levelling. It asks the server for the original file and leaves the signal alone. If you turn the volume below 100%, the line under the song says so.

On Windows it can ask for exclusive output, and it reports what mpv accepted without claiming more. On Linux it reports the rate PipeWire or PulseAudio runs the sink at, and whether that means the sink resamples what mpv sends. [audio.md](audio.md) explains what the readout can and can't know.

## Lyrics

Synced lyrics from your files fill in word by word on the lyrics page, in the deck, and in the mini player. Looking up missing lyrics on LRCLIB is off until you turn it on.

## Desktop

- Run as a mini player or from the tray. Media keys and the system media controls work (MPRIS on Linux, the media flyout on Windows). Pressing play with nothing loaded picks up the queue saved on the server.
- Find any action with Ctrl+K. Change its keys in `keybindings.json` and add colour themes as files in the config folder (`~/.config/squiggly`, `%APPDATA%\Squiggly` on Windows, or `~/Library/Application Support/Squiggly` on macOS). Saved changes apply at once.
- Add your own commands, menu items, pages, and themes with extensions, which are folders of TypeScript in the config folder that reload when you save. Extensions can also put a line in the deck and the mini player, and a section on the Playlists page. See [extensions.md](extensions.md).

## Offline

Keep records, playlists, and a mix's songs on a desktop or Android device. Kept songs play from the device whether you're online or not, which also saves bandwidth. When your server is out of reach, Home shows what is kept and the rest of the app says so. The Kept page is on the Playlists page and at G then K. The browser version can't keep songs.

## Android

The Android app connects to your Navidrome server itself and keeps playing with the screen off, with controls in the notification and on the lock screen. It's made for the Galaxy Z Flip: the main screen, Flex Mode, and a view of its own on the Flip 5, 6, and 7 cover screens. See [android.md](android.md).
