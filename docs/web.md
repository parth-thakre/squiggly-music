# Browser version

```bash
npm run web
```

This serves the app on 127.0.0.1:5173. The browser plays the audio here, not libmpv.

## Signing in

The page asks for your Navidrome server the way the desktop app does. Without `https://` or `http://`, the host tries HTTPS first, then HTTP.

The password goes once to the host serving the page, which keeps the connection in memory for that browser. It lasts until the host restarts, a day passes without using it, or you disconnect in Settings. Nothing is written to disk, and the page never sees the password again. Each browser keeps one connection and the host keeps 32 at most. When it's full, one left unused for 10 minutes makes room. A failed connection says only that it failed, and repeated failures make the page wait before trying again.

## A server of its own

The host can also start with a server of its own, which every browser uses until it connects to another. Here the address needs its `https://` or `http://`:

```bash
SQUIGGLY_PREVIEW_NAVIDROME_URL=https://music.example.com \
SQUIGGLY_PREVIEW_NAVIDROME_USER=you \
SQUIGGLY_PREVIEW_NAVIDROME_PASSWORD='your navidrome password' \
SQUIGGLY_WEB_PASSWORD='a long password for this page' \
npm run web
```

Anyone who can open the page acts as that account, or can point the host at any server. So the host won't serve other devices unless `SQUIGGLY_WEB_PASSWORD` is 12 characters or longer. To reach it from your phone over Tailscale, set it and run `tailscale serve --bg 5173`.

## Offline

The page needs its host. The browser caches nothing, not even the page, and keeps no songs. When your server is out of reach, the page says so and offers Retry.
