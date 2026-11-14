# Peach Assist

Internal messaging and ticketing for one organisation, on hardware you already own.
Messages, departments, and a ticket queue people can actually see. Links to the email
you already use, so nothing is lost. Your data never leaves the building.

Version 2.26.

## What it does

- **Messaging** — direct chats, groups, departments, and shared rooms with guest links.
- **Tickets** — raise one from a conversation, set status, priority and assignee, reopen
  a closed one. The queue lives beside the conversation that produced it.
- **Mail** — in-app mail between colleagues, and one click to hand a message to your own
  mail client. Nothing is re-typed.
- **Work** — tasks, a calendar with meetings, time off, and a work-hours clock.
- **Drive** — personal folders and shared room folders, with versions and per-file sharing.
- **Wall** — one shared board of posts, replies and likes.
- **Networking** — LAN-first, with a UPnP port mapper for the cases where people need in
  from outside. A public address is optional and off unless an administrator sets it.
- **Updates** — one release feed serving both the Windows build and the phone app.

## What it is not

- No voice or video calls, no voice notes, no audio or video uploads. Version 2.26 removed
  them. To dictate, use the microphone key on your keyboard: it types ordinary text.
- No cloud account, no telemetry, no analytics, no crash reporting.
- No antivirus or file scanning.

## Running it on Windows

npm install
npm run build
start.bat

`start.bat` sets a development password and prints the address. Change the password before
anyone else can reach the server. The database, uploads and backups live in `data/`, which
is never committed.

Node 22 or newer, with `--experimental-sqlite` if your Node still marks it experimental.

## Building the phone app

npm run build
# copy dist/ and public/ into android/app/src/main/assets/nodejs-project/
cd android
gradle assembleDebug

The APK installs over the previous version; the package id does not change, so nothing is
uninstalled and no data is lost.

## Updates

`scripts/update.mjs` checks a release manifest, verifies the checksum, swaps `dist/` and
`public/`, and keeps a backup. `scripts/make-release.mjs` builds the manifest and the
Windows zip for a tag. The feed address goes in `tools/update.feed`.

## Licence

Not decided yet.
