# Running Peach Assist

For whoever installs it and keeps it alive afterwards. Plain instructions, no theory. The
in-app manual at `/help` teaches the people who use it; this page is for the person who owns
the machine.

Before anything here, read the manual's opening page (`/help`, then **What you need**). If the
connection does not give you a public address, or the router will not open a port, nothing in
this file changes that.

---

## 1. First run

1. Double-click `build.bat` once on a fresh copy. It installs the dependencies and compiles the
   server. It prints nothing cheerful; wait for it to finish.
2. Start it with `start.bat`.
3. Open `http://localhost:3000`. A brand-new server sends you to `/setup`, which asks three
   things:
   - **How should this messenger be reachable?** Just this network, a free No-IP name, or you
     handle the networking yourself. This decides whether the server ever asks the router for a port.
   - **What is this server for?** Personal or business; it sets wording and defaults.
   - **Which parts do you want?** Untick what you will not use. Everything can be switched back
     on later from Administration.
4. Sign in as the administrator. The account is created on first start; if no password was set,
   the server prints a generated one into its console window once. Change it with:

   ```
   set-password.bat "a better password"
   ```

   The server can stay running while you do that.

### If you chose a No-IP name

The setup page shows five lights, in the order the manual lists them. Each one names its own
cause rather than saying "something went wrong". We do not teach router configuration: the
checks tell you what is wrong, and fixing it is either our job or outside the supported setup.

1. **A public address** - if the router's address is private, it is carrier-grade NAT. Stop
   here and use LAN-only mode, or move to a connection that gives you a public address.
2. **The port is open** - switch UPnP on at the router and press **Check my network** again.
3. **The name points here** - add the free No-IP name under Administration, then check again.
   No-IP asks you to confirm a free hostname periodically; if the name suddenly stops working,
   sign in at No-IP and confirm it.
4. **Reachable from outside** - test from a phone with mobile data, not from the same Wi-Fi.
5. **A trusted certificate** - until this is green the server speaks plain HTTP, and on the open
   internet that means passwords cross in clear text. Use LAN-only mode until it is done.

A red light is information, not a failure of the software. Two routers in a row, carrier-grade
NAT and somebody else's firewall are outside the supported setup.

---

## 2. Day to day

- The server runs in a console window, or hidden through the supervisor. `stop.bat` stops it,
  `restart.bat` stops and starts it in one move.
- Everything lives in `data/`: `app.db` (the database) and `uploads/` (files people sent). Copy
  that folder and you have everything.
- The administration panel has a **Server** tab for the parts you will actually touch: the
  public address, port mapping, dynamic DNS, modules, retention and the backup list.

---

## 3. Updating

There is no auto-updater, on purpose: replacing a running service silently is how people lose
data they were not told to back up. The procedure is short.

1. **Back up first.** Administration -> Server -> **Back up now**. Download the copy it makes.
2. **Stop the server** with `stop.bat`.
3. **Replace the build, not the data.** Put the new `dist/` and `public/` in place, and the new
   `package.json` and lockfile. Leave `data/`, `certs/` and `tools/*.env` exactly where they are.
   If the new version adds a dependency, run `build.bat` again rather than copying
   `node_modules` by hand.
4. **Start it** with `start.bat`, and read the console. It prints the port, the addresses it is
   listening on and what the router or VPN did. Anything wrong is usually in the first ten lines.
5. **Check it worked:** sign in, open a chat with history in it, and send one message. History
   present and a message arriving means the database and the socket are both fine.

If the new build will not start, put the old `dist/` back and start again. The database is not
touched by a failed start, which is the reason for step 1 rather than a hope.

---

## 4. Backups and restore

- **In the app:** Administration -> Server -> **Back up now** writes a complete copy of the
  database to `data/backups`, which can be downloaded. **Restore from a file** checks the upload
  is a healthy SQLite database, makes a safety copy, then replaces the tables in one transaction.
- **By hand:** stop the server, copy the whole `data/` folder somewhere else, start it again.
  That is the whole backup. It is also the one to do before an update or a move.
- **What the database does not contain:** uploaded files live in `data/uploads`, so copy the
  folder rather than the single file if people are sending files and pictures.
- **Test the restore once.** A backup nobody has restored is a belief, not a backup. Do it on a
  spare copy of the folder, not on the live server.

---

## 5. Moving to another machine

1. Stop the server on the old machine.
2. Copy the whole folder, `data/` included, to the new one.
3. Install Node if it is not already there (the portable build in
   `%USERPROFILE%\tools\node-v22.11.0-win-x64` is what the launchers expect).
4. Start it, sign in, send one message.
5. The public address has almost certainly changed: check the five lights again, and update
   dynamic DNS if the name is used.

---

## 6. What support covers

**Covered:** the application. Installing it, signing in, chats, files, the admin panel, backups,
updates, and telling you what a red light means.

**Not covered:** your router's firmware, your ISP, your mail provider, your hardware, or a
network somebody else administers. Those are diagnosed, named, and left alone.

**Never promised:** uptime. Nobody here controls your power, your connection or your router.
What is promised is a response and competence, within the hours agreed.

---

## 7. Handover checklist

Give this to whoever takes over, with the folder and the password:

- [ ] The folder, including `data/`, and a backup copy somewhere else
- [ ] The administrator password, changed from any default, in a password manager
- [ ] Which reachability choice was made (LAN-only, No-IP, or manual) and why
- [ ] The No-IP name, if one is in use, and the account it belongs to
- [ ] Where the certificate lives (`certs/`) and when it renews
- [ ] The port in use, and whether the router or a VPN is carrying it
- [ ] How to stop it (`stop.bat`), start it (`start.bat`), and update it (section 3)
- [ ] Who to ring, and in what hours
