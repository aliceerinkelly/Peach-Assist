# Peach Assist — the daily log

This file is written at the end of each working day, by whoever was working on the project,
for whoever picks it up in the morning. It is **append-only**: new days go at the bottom,
old days are never edited or deleted. Read the last entry first, then the one before it if
something doesn't make sense.

The point is simple: in the morning, read this and know where we are, what we decided, and
what is next — before opening a single source file. Then confirm the state against the code,
because a log describes intent and the code describes truth.

Each entry answers the same questions:

1. **What we were trying to do** — the goal in one or two sentences.
2. **What we actually did** — changes, in order, with file names.
3. **Decisions and why** — especially the ones that would look strange later.
4. **What is broken or unfinished** — honestly, including anything skipped.
5. **What is next** — the first three moves tomorrow.
6. **Traps** — the things that cost time and will cost it again.

---

## 2026-11-13 (early hours) — archives, and understanding a "bot"

### What we were trying to do

Two things tangled together: understand a "bot" that seemed to have been created but never
appeared, and settle how this project gets archived from now on.

### What we actually did

- Investigated the "bot". The admin panel's **REST API keys** form had been filled in with
  the name `botsy` and "may send messages" ticked. There is no bot feature in the app. What
  existed was one row in `api_tokens`: name `botsy`, prefix `omk_GJJoWMtP`, scopes
  `read,write`, created 2026-11-11 14:38 UTC, `last_used_at = null`. A credential, never used.
- Explained the API honestly: it can say who the key belongs to, list people, list chats,
  read a chat's recent messages, and post a message. It cannot create rooms, upload files,
  edit/delete messages, or touch admin. 120 requests/minute. It acts as the account it was
  created by, so the Announcements room still refuses it unless that account is an operator.
- **Revoked `botsy`** at the user's request (soft revoke via `revoked_at`, the same mechanism
  the panel's Revoke button uses). The row was left in place rather than deleted; the user
  can ask for a hard delete if they want the row gone.
- Confirmed the app's real announcement feature: a room titled `Announcements` with
  `announce_only=1`, plus a "Send as announcement" toggle in the composer. Currently empty
  (0 announcement messages). Accounts: alice kelly = operator (can post there), lorii kelly =
  manager, alice test = member (read only).
- Wrote `tools\announce.mjs` to demonstrate calling the API, and then **deleted it** when the
  user said the bot idea was shelved. No key file was ever created.
- Archiving went badly at first and is now settled. See "Traps".
- Created **`AGENTS.md`** in the project root, which now carries the rules a future session
  needs: the three archive types, what counts as necessary in a clean copy, where secrets may
  live, and the working-folder etiquette.
- Made the **Full backup**: `PeachMessenger-2026-11-12_2226.rar`, 16,210,032 bytes, 416
  entries, on the Desktop and in `G:\My Drive\Project Archives`, byte-identical (MD5
  `f7fae5c2…b02a3`), `Rar t` clean on both. `data\app.db` and both logs were captured through
  a snapshot and shared reads while the server kept running.
- Learned and recorded that the app has exactly one runtime dependency: `ws`. Without it the
  server dies at startup with `ERR_MODULE_NOT_FOUND: Cannot find package 'ws'`.
- Assembled a prototype Run copy in `%TEMP%` and started it on port 3111: it served
  `/health` 200, `/login` 302, `/app` 302, `/__build` 200, and created its own empty database,
  printing a generated operator password on first run. Then the user said not to make the
  distro yet, and the scratch copy was deleted.

### Decisions and why

- **A key is not a bot.** The panel's placeholder said "Website bot", which caused the whole
  confusion. Nothing was ever going to appear, because a key is a credential for software the
  user runs, not an agent waiting for commands. If a "/botsy does a task" bot is ever wanted,
  something has to be running and polling; the app does not do that.
- **The Full backup is the recall artifact.** It contains certificates, `tools\*.env`, the
  database and the logs — deliberately, because it is the thing that gets unarchived in the
  morning and resumed from. A `--no-secrets` habit would make it useless for that.
- **Secrets never leave the Full backup.** They do not go into a Run copy or an installer
  payload. A hand-out copy starts with its own database and no certificate, and that gets
  said plainly rather than being presented as a finished install.
- **The Run copy is built only on explicit sign-off**, when the user looks at the app and
  calls it finished. Not nightly, not early, not "to be ready". Until then the Full backup is
  the only archive.
- **Necessary means behaviour, not size.** Anything the app needs to do everything it does
  stays: `dist`, `public`, `ws`, launchers, the supervisor, cert renewal, attestation, docs.
  Only build toolchain (`typescript`, `@types`), logs, `refs`, and the user's own data and
  secrets are left out of a clean copy.

### What is broken or unfinished

- `Project Archives` holds **three** PeachMessenger archives: `1947` (36.6 MB), `1949`
  (456 KB) and tonight's `2226` (16.2 MB). The standing rule is two. Not trimmed — the user
  has not said which to drop.
- The older archive `2159` carries a version of `AGENTS.md` from before the last edits. It
  predates tonight's `2226`, which is current.
- The distro and the installer folder do not exist yet, by instruction.
- The "botsy" row is revoked but still in the database.

### What is next

1. Read this log, then `AGENTS.md`, `README.md`, `BLUEPRINT.md`; check `/health` and
   `dist\server.js` mtime before assuming anything about state.
2. Decide the archive trim (keep two) when the user is ready.
3. Whatever feature work the user names next. The distro waits for the "wonderful finished
   application" moment.

### Traps

- **Rar exclusion masks do not match paths the way you expect.** `-xnode_modules` looks
  harmless and instead sweeps the folder in (or fails to exclude it), which once put the
  certificate private keys into a temp archive. Archive the whole folder and exclude nothing.
- **`rar` exit codes get eaten by pipes.** `"$RAR" a ... | tail -5` reports `tail`'s status.
  Redirect to a file and check `$?` directly.
- **Running Rar from inside the project folder** makes `PeachMessenger` unfindable as a
  target ("WARNING: No files"). Run it from the parent.
- **The running server locks `data\app.db`, `-shm`, `-wal` and both logs.** Use SQLite
  `VACUUM INTO` for a consistent database copy and `[System.IO.File]::Open(..., 'Open',
  'Read', 'ReadWrite')` for logs. Never ship an archive with those silently missing.
- **Bash path substitution mangles backslashes in file listings.** `${line//\\//}` gave
  "PeachMessengersrc/server.ts" and produced eight false "MISSING" reports. Use
  `grep -E 'src.server\.ts$'` style checks or `tr`/`cut` instead.
- **Ask before deleting.** A `rm` of my own scratch file was fine; anything in the project
  needs a reason and usually a request.

---

## 2026-11-13 (thinking session) — where we stand if we went on sale

Note for the morning: this was a conversation, not a build. Nothing was changed in code.
Recorded because the assessment is the useful part, and because it decides what gets built next.

### Short answer

Strong as a demo or a hand-installed private system. Not there yet as a product someone pays
for and installs alone — roughly half.

| Shape | Ready? |
|---|---|
| Demo / proof of concept | yes |
| Installed by the user's own operator, for one business, with support | close — needs onboarding and an update path |
| Download-and-install product for strangers | no — installer, first-run wizard, network auto-setup, buyer docs |
| Hosted service with accounts and billing | far off — multi-tenancy, isolation, ops, compliance |

### What a buyer hits in the first hour

- They install it and get a login screen; the operator password was printed to a console they
  never saw. No setup wizard, no "create your admin account". That is a hard stop, not a
  rough edge.
- They cannot do the network part: port forwarding, UPnP, VPN gateway, DNS for a certificate,
  IONOS API keys. That is the installer's evening, not the customer's. Unless the product is
  hosted by us, network setup kills the sale.
- No uninstall, no upgrade path, no way to move servers. A paid install that cannot be
  updated is a liability the moment a fix ships.
- Nothing reports failure back. The supervisor heals the code on this machine; a customer's
  machine has no equivalent and no way to tell anyone something broke.

### What would make me nervous if money changed hands

- Single-tenant, single-space. Right for one business, wrong for a market of customers.
- Every message lives in one SQLite file on the operator's disk; whoever holds that file reads
  everything. For a "private messenger" pitch that is the first question a buyer asks, and
  today the honest answer is yes, the operator can read it all.
- The self-healing is integrity, not security. Hidden fragments are a tripwire, not a defence.
- Auth is homegrown. 2FA and API keys exist, but adversarial traffic has not touched it.
  Login rate limiting, lockout, password reset and session revocation each need verifying
  before any of them is promised to a buyer.
- No terms, no privacy note, no licence, no backup promise. Selling means answering "what
  happens to my data if this dies".

### Where it could sell tomorrow

Not shrink-wrap software. A private messenger for one small team, installed and supported by
the operator, on their LAN or VPN, with no cloud dependency. In that shape the weaknesses
become the pitch: no cloud, no subscription, the operator owns their data. Price it as an
installation plus support, not as a download.

### The decision that comes first

Is this something installed for people, or something they sign up for? Pick one and the gap
list becomes short and finishable. Try to be both and it stays a hobby.

### If the answer is "installed by us"

1. A first-run wizard: create the operator account, choose a port, done — no console password.
2. An update path: replace the build, keep the data, restart cleanly.
3. A backup and restore story the customer can understand, not just one we can perform.
4. A short operator guide for whoever runs it after us — install, renew, recover.

---

## 2026-11-13 (later) — networking, selling, and the first-run fork

Decisions from a long thinking session. Still no code changed. These are the things we agreed,
so tomorrow starts from them rather than re-arguing them.

### The network model (this is the decision)

- **ProtonVPN comes out of the default path.** Too much to ask of the audience; VPN is a
  hobbyist instruction, not a small-business one. It stays as an advanced option.
- **UPnP + No-IP is the default.** The app already has a No-IP updater (`DDNS_IP`,
  `DDNS_PASSWORD`). The customer's router maps the ports; the hostname makes the moving
  address human.
- **This fixes the certificate problem.** Proton made 80/443 unreachable, which forced DNS-01
  and a DNS zone with an API and therefore a purchased domain. With UPnP on their own router,
  HTTP-01 becomes possible: a trusted certificate on a `ddns.net` name, no domain, no TXT
  record, no DNS API key.
- **Owning a domain is optional**, for people who want prettier URLs and more control.
- **Supported setup:** one router, UPnP on, public IPv4 address. **Outside the supported
  setup / outside support:** two routers in a row, carrier-grade NAT, a firewall someone else
  controls. We do not teach networking and we do not fix their network.
- **LAN-only is a real product**, not a consolation prize: no ports, no certificate, nothing
  to fail. Simplest supported thing we can offer.
- **`src/portmap.ts` does not bind its socket to the LAN adapter**, so its "no UPnP gateway
  answered" message is wrong on this network. Must be fixed before any network testing, or
  the tests teach the wrong lesson.

### The first-run fork (agreed wording)

Three choices, all leading into the same app — no separate builds:

1. **Just this network** — works on the Wi-Fi and nowhere else. Nothing to open, no
   certificate, no account.
2. **Guided internet setup** — walk through No-IP and the router's UPnP, step by step; if
   something blocks it, the setup says what.
3. **I'll handle the networking** — they open the port and manage the name. Checkbox: "I
   understand network setup is my responsibility and outside support."

Notes on it: the hold-harmless language belongs in the terms and the checkbox, not on the
button (a waiver on the very first screen reads like a warning sign to the geeks most likely
to pick it). Guided means walk them through and name what's wrong — **not** fix their router.
Record which option was chosen so it shows in the admin panel and travels in the support
bundle.

### The wizard (where the honest diagnostics live)

Five stages, each green or red with a plain-English cause:

1. Public address check — router WAN vs outside view; if they differ it's CGNAT, say so, offer
   LAN-only.
2. Port mapping — UPnP discovered and bound correctly, which port answered, or why none did.
3. Name check — No-IP credentials, hostname updated, world resolves it to this machine.
4. Reachability — a real external probe, not a hope.
5. Certificate — issued, trusted, last renewal.

The site stays a sentence; the wizard does the work, because that is where attention already
is.

### Selling (agreed shape)

- **Sell hours, but quote the first job as a fixed price.** Customers hate open meters; the
  install price should be a number. Additional work sells as prepaid two-hour blocks. Travel
  and waiting billable, stated up front.
- **Excluded from any hour sold:** their router, their ISP, their mail provider, their
  hardware, anything they changed after we left.
- **Do not sell uptime.** Sell response time and competence.
- **The audience is technical enough.** No-IP's existence proves people pay for exactly this.
  Geeks install it themselves and never buy an install; what they buy is the install *for
  someone else* — the small office or family business they've been roped into helping.
- **Education split:** concepts free on the site (what a private messenger is, what CGNAT is),
  step-by-step procedure paid/with the licence. Plus a network-readiness page that
  prequalifies leads before they buy.
- **The paid-support features that matter:** a support bundle (logs, version, network lights,
  recent errors in one file), versioned builds with checksums so a fix can actually be
  delivered, and a written scope.

### Disclaimer wording (agreed direction)

Plainly: intended for home and small-business networks; assumes you can install software, have
administrator rights on the machine, and control your own router — enough to switch UPnP on.
It also assumes a public address. Two routers, CGNAT, or someone else's firewall is outside
the supported setup and outside support. Keep the vocabulary consistent everywhere:
"supported setup", "outside support", "LAN-only mode".

### The test plan, cheapest first

1. Fix the socket binding in `src/portmap.ts` so the diagnostic stops lying.
2. On this line, take Proton out of the path, let UPnP map the port, publish `IP:port`, and
   reach it from a phone on mobile data. Proves the port half.
3. Point a No-IP name at it and get a certificate. Proves the naming half.
4. Force a renewal rather than waiting — issue a second certificate and check the path.
5. Hand it to one person on a different ISP and watch, without helping, where they stop. Their
   confusion is the manual's table of contents.

Still open: would a relay be offered to CGNAT customers or would they be refused; and default
port for the certificate (443 vs 80) given some networks block one or the other.

---

## 2026-11-13 (last note before sleep) — the Required List

Agreed: the product needs a **Required List**, and it should be the opening page of the manual.
Everything else depends on it being honest. Three buckets, because "required" flattens things
that differ in kind.

### Required — nothing works without these

- A Windows 10 or 11 computer that stays on. It is the host, not a laptop that sleeps.
- Administrator rights on that machine: can install software, can allow it through the
  Windows firewall.
- One router, under their control — they can log into it and see a UPnP setting.
- UPnP switched on (the wizard's second light proves it).
- A public IPv4 address. If the router's WAN address differs from the outside view they are
  behind carrier-grade NAT and it cannot work; the wizard's first light says so.
- A free No-IP account, if they want internet access. Sign-up is two minutes.
- Somewhere to keep backups: any external drive or cloud folder they already use.

### Required only for internet access — not for LAN use

- Port 80 or 443 reachable from outside. One of them will be; if both are blocked the
  certificate cannot issue and the install is LAN-only.
- The No-IP hostname actually updating as their dynamic address changes.
- A device to test from that is not on their Wi-Fi — a phone on mobile data is the honest
  test, because that is the path a colleague takes.

### Not required — and saying so saves support calls

- A VPN. Not needed at all in the default path.
- A static IP address.
- A purchased domain name — only for people who want a prettier URL.
- A server, a VPS, or cloud hosting.
- Any account with us.
- Port forwarding done by hand. The app asks the router through UPnP.

### Two wording rules for the list

- Every required item gets **a way to check it**, not just a name. A list of requirements
  without checks is a list of things to worry about.
- **"Not required" matters as much as "required".** Half of what stops a technical person
  installing this is the assumption they need a domain, a VPS, or a static address.

### Next move when work resumes

Write this as the manual's opening page, and mirror it into the wizard's checks so the list and
the lights say the same things in the same order. Five checks, same words, both places.

---

## 2026-11-13 (build session) — the decisions turned into code

### What we were trying to do

Take the task list out of the three thinking entries above and actually do it, rather than carry
it into a fourth day. "Go" was given, so this was a build session.

### What we actually did, in order

- Read this log, `AGENTS.md`, `README.md`, `BLUEPRINT.md`, then checked state against the code:
  `/health` 200, `dist\*.js` newer than `src\*.ts`, port 3000 owned by one supervised process.
- **Found the log was wrong about `src/portmap.ts`.** The entry above says the socket is not
  bound to the LAN adapter. It is: `localIPv4s()` returns every address and `discoverIgd()` calls
  `sock.bind(0, localIp)` plus `setMulticastInterface(localIp)` for each, which is exactly the fix
  that was needed. That was done on 2026-11-12 at 19:08, before the log claimed otherwise.
  Correction recorded here because this file is append-only; the old entry stays as it was.
- Put the **Required List** into the manual as its opening section, before Chapter 1
  (`public/help.html`), with a contents link **Before you begin: what you need**. Three groups:
  required, required only for internet access, and not required. No chapter renumbering: the 24
  chapters keep their numbers.
- Added **`/api/network/check`** to `src/server.ts`: the five lights, in the manual's order and
  wording. Public address (with a private/CGNAT test on the router's own answer), port open,
  name points here, reachable from outside (a real `/health` fetch), trusted certificate. Each
  returns a cause in plain words, not "something went wrong". Open to this machine and its
  network during first run, admin-only afterwards.
- Added the **three-way fork** to the setup wizard (`public/setup.html`, `public/setup.js`):
  *Just this network* / *Guided internet setup* / *I'll handle the networking*. Guided runs the
  five checks; manual shows the checkbox ("network setup is my responsibility and outside
  support") and will not continue until it is ticked. The choice is saved as the `reach` setting
  and read back on the next visit; `/api/setup` now returns `reach` and `reachAck`.
- Wrote **`OPERATOR.md`**: first run, the five lights in order, day to day, **updating** (back up,
  stop, replace `dist`/`public`, keep `data`/`certs`/`tools\*.env`, start, verify with one message),
  backups and restore, moving machine, what support covers, handover checklist.
- Rebuilt: `tsc --noEmit` clean, `tsc` clean. Restarted through `tools\restart-server.ps1`
  (one supervised instance, pid 10140, port 3000). Regenerated `public/manual.pdf` from `/help`
  with headless Chrome (193,382 -> 214,557 bytes).
- Verified by request: `/health` 200, `/setup` 200 and containing the three `data-reach` buttons,
  `/api/setup` returning `reach`/`reachAck`, `/api/network/check` answering 401 without an admin
  session (route present, correctly gated, not a 404), `/help` containing the new opening page.

### Decisions and why

- **The five checks live in the wizard, not on the website.** The site says one sentence; the
  page that is actually being used at the moment of trouble carries the diagnosis.
- **Same words in both places.** The manual and the lights describe the same five things in the
  same order, so a support call can say "read light three" and mean it.
- **The hold-harmless line is a checkbox, not a button.** On the button it reads like a warning
  sign to exactly the people most likely to choose manual setup.
- **No separate build for each reach option.** All three lead into the same app; the choice only
  decides whether the router is asked for a port.
- **The log is not edited to fix the `portmap.ts` sentence.** Append-only is the rule; the
  correction is this entry, and the code was already right.

### What is broken or unfinished

- **The live network tests are still not run.** Testing UPnP on this line needs Proton out of the
  path, and issuing a certificate needs a No-IP account. Neither was touched: the first was not
  authorised and the second needs credentials only the user has.
- **The wizard UI was not looked at in a browser.** The HTML, the JS and the endpoints were
  checked by request; nobody has clicked through the three choices. Printing a page and reading
  its bytes is not the same as seeing it.
- **`/api/setup` still finishes a first run without creating an account.** The operator account is
  still made at first start with a printed password. The wizard asks about reachability, audience
  and modules, not "choose your administrator password" — that item from entry two is not done.
- **`Project Archives` still holds three PeachMessenger rars** (`1947`, `1949`, `2226`). The
  two-archive rule needs a decision on which to drop, and deleting is not something to do on my
  own initiative.
- **A fact worth checking before it goes in any manual:** HTTP-01 validation is performed on port
  80, so a certificate that uses it needs 80 reachable at issuance even if the app then serves on
  443 or 3000. Not verified on this connection; do not promise it until the certificate step is
  actually run.
- The second headless Chrome run left a profile in `%TEMP%\pm-pdf-profile` that could not be
  deleted while Chrome held it open. Harmless, but it is litter.

### What is next

1. Read the wizard in a browser: `/setup`, all three choices, the five lights, and the checkbox
   refusing to continue until ticked.
2. The first-run account: ask for the administrator name and password inside the wizard instead
   of printing one to a console nobody watches.
3. The live test, when authorised: Proton out of the path, UPnP maps the port, phone on mobile
   data, then a No-IP name and a certificate.

### Traps

- **`code_search` cannot see this folder.** It is scoped to the chat's own workspace, and answers
  "directory does not exist" for `Desktop\PeachMessenger`. Use `grep -n` through the shell here.
- **`grep` cannot read text out of a PDF** — it is compressed. Check a regenerated PDF by size
  and timestamp, or extract the text properly; a zero match means nothing.
- **Headless Chrome writes the PDF asynchronously.** Checking the byte count in the same command
  reports the old size and looks like a failure. Re-stat afterwards.
- **`tools\restart-server.ps1` is the only safe restart.** It stops the keep-alive task first; a
  plain kill of node.exe leaves the supervisor to fight the new process for port 3000.
