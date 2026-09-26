# Desktop app

Slurp ships as a macOS app built with Electron: it starts the same built server the web UI uses and opens a window onto it, so the app and `npm run serve` are the same code. `npm run app:dist` builds `release/Slurp-<version>-arm64.dmg` in about 3 minutes. Windows and Linux come later. Code: `electron/main.mjs`.

## Commands

| command | what it does |
|---|---|
| `npm run app` | builds the site, then opens it in a dev copy of the app (no packaging) |
| `npm run app:dist` | builds the site, then packages `release/mac-arm64/Slurp.app` and the DMG |

- The package config lives under `build` in `package.json` (electron-builder). `release/` is gitignored.
- The icon is `build/icon.svg`, rendered to `build/icon.png` (1024px); electron-builder turns that into the `.icns`. It's the favicon's S tile, inset to the macOS icon grid, square corners on purpose.

## How it runs

On launch the app picks a free port, starts `dist/server/entry.mjs` in an Electron utility process bound to `127.0.0.1`, waits until it answers (20 s max, else an error box and quit), then opens the window.

- **One server per app.** It lives as long as the app does. Closing the window on macOS keeps the app, and any running job, alive; clicking the Dock icon opens a new window. Quitting stops the server.
- **One app at a time.** A second launch just focuses the first window.
- **Menus:** the standard macOS app, Edit, View and Window menus, so copy, paste and zoom work in the handle box and everywhere else. File adds **Choose Archive Folder…** (⌘⇧O) and **Show Archive Folder**.
- **Update on launch:** once the window is up, the app starts **Update all** in the background (records and reports, never media). See [Updating on launch](#updating-on-launch).
- **Links:** anything pointing off the app's own server opens in your normal browser. The window never navigates away from Slurp.
- **`PATH`:** apps launched from Finder or the Dock don't inherit your shell's `PATH`, so `ffmpeg` from Homebrew would go missing and every video poster would 404. The app adds `/opt/homebrew/bin` and `/usr/local/bin` for the server.

## Updating on launch

Every time the app opens, it brings every archive up to date without you doing anything: the main process POSTs `{ mode: 'update-all', media: false }` to its own server, with the token cookie and a matching `Origin`.

- **Records and reports only.** Media can be gigabytes, so it only comes down from an account's own Update button or the Media tab.
- **You can watch it.** Open Accounts while it runs and the Update all panel attaches to the job and replays the log so far.
- **It won't collide.** If you press Update on an account meanwhile, you get the running job instead of a second one (see [web-ui.md](web-ui.md#jobs)).
- **Offline is fine.** A network failure just logs per account; the archives stay as they were.

## Archive folder

Archives default to `~/Library/Application Support/Slurp/archives`, because an installed app can't write inside its own bundle.

- **Choose Archive Folder…** saves the pick to `~/Library/Application Support/Slurp/config.json` as `archiveRoot`, restarts the server on it, and reloads Accounts. Point it at a checkout's `archives/` and the app and `npm run dev` share one set of archives.
- The server gets the folder as `SLURP_ARCHIVES`, the same setting the web UI already reads (see [web-ui.md](web-ui.md)).
- `package.json` has a top-level `productName: "Slurp"`, so dev copies and the packaged app share that same data folder.

## Per-launch token

Every launch generates a random 32-byte token. The server only answers requests carrying it, and only the app's own window has it.

- The app passes it to the server as `SLURP_TOKEN` and sets it as an `httpOnly`, `SameSite=Strict` cookie (`slurp-token`) on the window's session before loading anything. Page scripts can't read it.
- `src/middleware.ts` compares the cookie in constant time and returns 403 on a missing or wrong one. Prerendered pages (About) and static files (CSS, JS, the favicon) skip the check, since they carry no archive data.
- Why: a server on `127.0.0.1` is readable by every other program on the machine and by any web page that guesses the port. The origin check only ever blocked writes (see [web-ui.md](web-ui.md#security)); the token covers reads too.
- Without `SLURP_TOKEN` (plain `npm run dev` or `npm run serve`) nothing changes.

## Signing and size

- **Signing:** electron-builder signs with whatever identity is in the keychain. An *Apple Development* certificate runs fine on the machine that built it. Handing the app to anyone else needs a *Developer ID Application* certificate plus notarization, or they get Gatekeeper's "unidentified developer" warning.
- **Size:** 438 MB installed, 170 MB DMG. `asar` is off and the package ships every runtime dependency, including Astro's whole build toolchain, which the server doesn't need. Bundling the server into one file with only `sharp` left external should roughly halve that. `asar` stays off until then, because `sharp`'s native binaries and the static files have to be readable from disk.
- **Native pieces:** `sharp` is a Node-API module, so it runs in Electron's Node without a rebuild. It's still built per OS and CPU, which is why Windows and Linux builds need to happen on those systems (a GitHub Actions matrix is the plan).
