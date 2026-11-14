# Project instructions

## Two modes: "let's think" and "go"

- **"let's think"** — planning mode, adopted by the user. Do not edit files, do not run
  build/test commands, do not start work. Talk: options, tradeoffs, risks, what the ugly
  alternative looks like, what you would pick and why. Argue honestly instead of agreeing.
  Ideas raised in this mode are not instructions and are not adopted until the user says so.
  The one exception: reading a file to answer a factual question about the code is fine —
  say that you are looking, then answer. No changes either way.
- **"go"** — build mode. Resume normal working behaviour.
- Until the user switches out of thinking, keep it to conversation. Do not quietly turn an
  idea into a task.

## The daily log: `DAYLOG.md`

- **Start of every session:** read the newest entry in `DAYLOG.md` before anything else,
  then `README.md`, `BLUEPRINT.md` and this file. Confirm the log against the code — the log
  says what we intended, the code says what is true.
- **End of every working day, before the user goes to bed:** append one entry to
  `DAYLOG.md`. Exhaustively, in plain language, no code blocks unless a name matters. Same
  six headings every time:
  1. What we were trying to do
  2. What we actually did — in order, with file names
  3. Decisions and why — especially anything that will look strange later
  4. What is broken or unfinished — honestly, including anything skipped
  5. What is next — the first three moves tomorrow
  6. Traps — what cost time today and will cost it again
- **Append only.** Never rewrite or delete an earlier day's entry, even to correct it; add a
  new note instead. The log runs until the project is done, and its length is the point.
- The log is written for whoever picks the project up cold, which may be a different session
  with no memory of today. Names, paths, decisions, and why.

## Archiving (Peach Assist)

The archive is the working folder and its contents. That is the default and it does
not need justifying.

- **Default: everything.** Every file and subfolder goes into the rar — `src`,
  `public`, `scripts`, `tools`, `certs`, `data`, `dist`, `logs`, `refs`,
  `node_modules`, `.env` files, tool binaries, build output. No `-x` exclusions.
  Node modules and logs are not "clutter" to be quietly dropped; a restore may
  need them.
- **The one exception:** when the user and the assistant deliberately decide to
  clean unnecessary files out, that cleanup happens *first*, in the folder, and
  the archive is then made of the cleaned folder. The cleanup is explicit and
  agreed; it is never an invisible step inside the archive command.
- **Locked files still go in.** If a running process holds a database or log open,
  read it through a shared read (`[System.IO.File]::Open(path, Open, Read,
  ReadWrite)`) or a `VACUUM INTO` snapshot, rather than skipping it. If something
  genuinely cannot be captured, say so in the report — never leave a silent gap.
- **Verify before finishing:** `Rar t` the archive and list its entries to confirm
  the top-level files and the main folders are present. Copy to `G:\My Drive` and
  check the byte count matches.

## Three archive types

There are three, and they are not interchangeable. Ask which one is wanted when it is
not stated; never silently pick.

### 1. End-of-day safety archive
- The working folder exactly as it stands: every file and subfolder, nothing excluded
  (`src`, `public`, `scripts`, `tools`, `certs`, `data`, `dist`, `logs`, `refs`,
  `node_modules`, `.env` files, binaries).
- **Not encrypted** — a plain rar. It therefore contains the certificate private keys,
  the API keys in `tools\*.env` and the database, so it is never shared.
- Name: `PeachMessenger-YYYY-MM-DD_HHMM.rar`.
- **Two copies:** one on the Desktop beside the working folder, one in
  `G:\My Drive\Project Archives`. Confirm both byte counts match.
- The working folder is left exactly where it is. It hosts the running server and the
  logon task; moving or deleting it stops the app. The user moves it if they want it off
  the Desktop — do not do it for them, even though they dislike the clutter.

### 2. Distribution copy
**Only when the work is finished and the user explicitly says so** — the moment they look at
the app and call it done. Do not build it as a nightly job, do not build it early "to be
ready", and do not build it because a previous message mentioned it. Until that sign-off the
Full backup is the only archive.

When it is built: a clean, operational folder with every feature working, minus only what is
not part of running it.

**The test is not size, it is behaviour.** Before delivering, start it from the copy and
confirm sign-in, chats, messaging, admin, announcements, self-healing and certificate
renewal still work. If a feature breaks, whatever it needed was necessary and goes back
in. A copy that starts but has lost features is a hatchet job, not a clean copy.

**Necessary — always included because the app needs it to be itself:**
- `dist` (the compiled app), `public` (every page and asset), `package.json` + lockfile
- `node_modules\ws` — the only runtime package; without it the server dies on startup with
  `ERR_MODULE_NOT_FOUND: Cannot find package 'ws'` before opening a port
- launchers: `start*.bat`, `restart.bat`, `stop.ps1`, `run-elevated.bat`, `build.bat`
- `tools\`: `server-supervisor.ps1`, `run-hidden.vbs`, `renew-cert.ps1`, `dns-hook.*`,
  `close-windows.ps1`, `fix-hosts.ps1`, `lego.exe`, mail/notify helpers — these are the
  self-healing, restart and renewal machinery, i.e. features, not clutter
- `scripts\build-attest.ps1` and `attest.config.json` — the build attestation is a feature
- docs: `README.md`, `BLUEPRINT.md`, `features.html`, this file

**Left out — nothing the running app uses:**
- `node_modules\typescript` and `@types\*` (23 MB of build toolchain; the compiled app never
  touches them)
- `logs`, `refs`, editor droppings, previous archive copies
- `data\app.db` — belongs to the person running it; a clean copy starts with its own
- `certs` and `tools\*.env` — see below

**Secrets live in the Full backup, nowhere else:**
- `certs\` (the TLS private keys) and `tools\*.env` (IONOS, notification keys) belong to the
  **Full backup only** — that archive on Drive, plus the live working folder. They are the
  reason the Full backup exists.
- The Full backup is also the **recall artifact**: the user unarchives the whole folder and
  asks for a walkthrough of what was being built. So it must be complete enough to resume
  from with nothing else — code, tools, certificates, database, docs.
- Neither the **Run copy** nor the **Build folder** ever contains `certs\` or `tools\*.env`.
  A Run copy starts with its own database and no certificate; say so plainly rather than
  describing it as a finished install. If a delivery genuinely needs TLS to work on first
  launch, ask before putting a private key into it.
- When resuming in the morning: read `README.md`, `BLUEPRINT.md` and this file first, then
  the newest `PeachMessenger-*.rar` notes in the report — in that order, before touching code.

Built from a *copy* in the system temp folder, so the working folder is never modified.
Name: `PeachMessenger-clean-YYYY-MM-DD_HHMM.rar`. Two copies: Desktop and
`G:\My Drive\Project Archives`. This is a deliverable, never the source of truth: restoring
from it does not rebuild the app, it runs what was already compiled.

### 3. Installer input
- A staging folder holding everything the packaging step needs: the built app, the Node
  runtime, icons, manifest, extra assets and the installer itself. Sized for MSIX, a
  self-installing exe, or the project's own installer — it is expected to be large.
- Must carry `node_modules\ws` (or bundle `ws` into the app), plus the Node runtime: the
  built server imports `ws` at startup and will not run without it.
- Assembled in the system temp folder; the working folder is never the staging area.
- Name: `PeachMessenger-package-YYYY-MM-DD_HHMM.rar`.
- **Two copies:** Desktop and `G:\My Drive\Project Archives`.

## Working folder etiquette

- `C:\Users\alice\Desktop` is the user's: do not tidy, rearrange or delete on it.
  This project folder is the exception, and only for work asked for.
- Never delete anything in `tools\`. Binaries, `.env` files and helper scripts
  there are installed infrastructure, not clean-up items.
- Deleting a file the user asked to delete is fine. Deleting anything else on
  your own initiative is not.
- Do not open or extract the user's archives to inspect them unless asked.
