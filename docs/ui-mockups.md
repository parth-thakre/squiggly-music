# Five UI directions

These are isolated design studies for Squiggly's desktop music player. Open `/mocks.html` on the browser preview server. The existing player is unchanged. All albums, queue entries, and progress are sample content, not a connection to the native player. Controls only change the mockup. No audio plays and no device or signal measurements are invented.

## Design plan

All five studies keep the squiggly progress line, artwork, an accessible transport, and a queue. They differ in information hierarchy as well as color. Artwork is original, code-drawn sample sleeve art, not actual album artwork.

| Direction | Palette | Typography | Layout and principle |
| --- | --- | --- | --- |
| Cove | Deep teal `#10292b`, sidebar `#0b2123`, mist `#e2eeea`, muted sage `#a2b6b0`, mint `#bce0d0` | Trebuchet for headings, Arial for controls | Left-aligned library with quiet sidebar, wide featured album, bottom transport. Make browsing the default. |
| Daylight | Paper `#faf9f6`, ink `#292731`, violet `#66518b`, lilac `#e9e2f2`, grey `#76717e` | Georgia display, Arial controls | Top navigation, spacious album shelf, separate plum listening column. Let the collection feel owned and cared for. |
| After hours | Wine `#301722`, deep wine `#25111a`, pink `#ecc9d2`, muted rose `#bf9ea9`, warm white `#fff5ee` | Georgia track title, Arial controls | Large sleeve at left, track and transport in center, queue below. Commit most of the screen to one record. |
| Studio | Silver `#e4e7e8`, white `#f6f7f7`, charcoal `#273135`, slate `#647176`, blue `#34677a` | Arial with tabular numerals for track times | Dense queue and a compact hardware-inspired deck with honest signal-path placeholders. For listeners who keep the queue in view. |
| Blue note | Cobalt `#2545d6`, pale blue `#e3eaff`, white `#ffffff`, navy `#13266c`, periwinkle `#b8c8fa` | Trebuchet display, Arial controls | Oversized collection title and offset cover composition, horizontal record list, floating transport. Treat album browsing like a record shop window. |

```text
Cove          Daylight       After hours     Studio          Blue note
nav | feature header / nav   slim header     header          header
nav | shelf   shelf | player art | player    queue | deck    title | sleeves
bottom player shelf | queue  next-up row     queue | path    album list
                                                              player
```

## Review before implementation

Five differently colored versions of the existing three-column test shell would not answer the brief. These studies instead change the main task and composition: browsing, collecting, focused listening, queue management, and discovery. Avoid dashboard metric cards, pretend audio-quality badges, and decorative visualizers. Keep signal-path details in Studio only. The blue direction uses the strongest typography; the others give the artwork more weight. Browser controls are explicitly mock interactions and never call the desktop bridge.

## Preview interactions

Use the five direction buttons to compare. Album and queue buttons select sample tracks. The transport toggles its visual play state, previous/next change the selected sample, and the progress and volume sliders can be adjusted. Search filters the library or queue where present. Favorites update locally. The signal-path button reveals unverified output information. Reloading resets these sample-only changes. Each direction has a shareable `?view=` URL.
