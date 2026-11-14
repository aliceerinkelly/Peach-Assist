# Peach Assist blueprint — feature parity with a commercial reference

Source: the reference vendor's marketing pages and support documentation (homepage, feature
list, enterprise and on-premises pages, server guide, AI assistant guide).
First read 2026-11-10; re-read 2026-11-11 — see sections 8 and 9 for what that changed.
Legend: [x] done today · [ ] to build · (A) admin-only panel · (A*) admin only, plus manager role

## 1. Core messaging
- [x] 1:1 direct messages
- [x] Group chat rooms (create/delete from UI, guest links)
- [x] Slash command `/clear`
- [x] File / image / video drag-and-drop transfer in 1:1 and group chats
- [x] Image and video inline previews, file size limits
- [x] Delivered + read receipts per message (group: ticked when everyone has read)
- [x] Typing indicator
- [x] Message search (keyword, user, date range) over central history
- [ ] History log view with timestamps + attachments
- [ ] Replies / quoting, emoji picker
- [x] Acknowledgement messages (require ack, show who confirmed)
- [x] Polls in a chat window
- [x] Announcements (one-way, whole team or one user)
- [x] OTR / off-the-record messaging (never logged, gone on close) (A* policy)
- [x] Preset messages with shortcut keys + instant send
- [ ] Escape messages (tray-style short text)
- [ ] Keyboard shortcuts and command palette

## 2. Presence, status and directory
- [x] Online / Busy / Idle / Away / Offline status
- [x] Custom status text, with an automatic reply to private messages
- [ ] Alert when a contact's status changes
- [ ] Contact/group list (add, rename, block) (A: who may see whom)
- [ ] Departments / projects, hide users outside your department (A)
- [ ] Private social wall (post, comment, like across the org)
- [x] Network status: who is connected, from which address (A)

## 3. Voice, video, screen
- [x] 1:1 voice call (WebRTC)
- [x] 1:1 and group video call / conferencing (up to the people in the chat)
- [x] Screen sharing inside a call
- [x] Screen clipper: capture, crop, annotate, send to chat
- [x] Voice messages (record + send)
- [ ] Remote desktop view + control (opt-in per session)

## 4. Work management
- [x] Tasks / to-do lists: private, 1:1, team, room-scoped; assignees, due dates
- [x] Task reminders, task-based group chat
- [~] Reminders done for yourself (one-time); recurring and reminders for teammates still to do
- [x] Calendar with day/week view
- [x] Meetings/events created in-app, invites, reminders, meeting chat
- [x] iCal export/import for Google Calendar sync
- [x] Leave management: request, approve, track, holiday list (A*)
- [x] Work hours tracking
- [x] Reports: chat logs + work hours for all users (A*), own data only for others

## 5. Files and storage
- [x] Peach Drive: my files (private) and room drives
- [x] Folders, rename/move, download
- [x] File version history and update
- [x] Shared-with-team access control per file/folder
- [x] Storage quota display and limits (A)

## 6. Extra communication channels
- [x] Internal mail: subject, body, attachments, priority, recipients
- [x] Ticketing / live chat helpdesk for customers
- [ ] In-app notification centre + desktop notifications
- [ ] Push notifications for the web client
- [ ] Server-less LAN fallback messaging
- [x] Public REST API with key management (A); addon hooks not built

## 7. Administration (admin-only panel)
- [x] Admin panel shell with tabs, separate from the chat UI (A)
- [x] User management: create, disable, reset password, delete (A)
- [x] Roles: Admin / Manager / User, per-user permissions (A)
- [x] Departments and groups (A)
- [x] 2FA (TOTP) enrolment, enforced per user or org-wide (A)
- [~] LDAP / Active Directory import and sync (A): CSV directory import built; real LDAP sync needs a directory server
- [x] Communication restrictions: who may message whom (A)
- [x] Feature switches per user/group (files, calls, OTR, drive) (A); per person, group-level not built
- [x] Retention and logging policy, OTR exemption (A)
- [x] Broadcast announcement composer (A)
- [~] Server settings: port, addresses, port mapping and public URL editable; TLS certificates still managed outside the panel (A)
- [x] Loadable / unloadable feature modules, switched only from the panel (A)
- [x] Calendar and time off as separate modules, each with its own rail icon (A)
- [x] Unadvertised typed commands (/nick, /join, /list, /msg, /me, /whois, /invite, /topic, /part), switched only from the panel (A)
- [x] Searchable teaching manual served at /help (A)
- [x] Backup / restore of the database (A)
- [x] Audit log of admin actions (A)
- [x] Network diagnostics page (port mapping, VPN, addresses) (A)

## 8. Features the reference has that Peach Assist does not

Verified against their pages on 2026-11-11. "Not mentioned" is not the same as "absent":
these are features the reference advertises that Peach Assist has no equivalent for.

**Clients and platforms**
- [ ] Native desktop apps for Windows, macOS and Linux, plus Android and iOS apps.
      Peach Assist is browser-only, so there is no app to install and also nothing to push to.
- [ ] Push notifications to phones while the app is closed; sync across devices on one account.
- [ ] Server-less LAN messaging: users on the same network keep chatting while the server is down.

**Intelligence and social**
- [ ] AI assistants: an "Assistants" group in the user list, admin switch
      (Server Manager → Client Settings → "Allow users to use Assistants"), any
      OpenAI-compatible provider (OpenAI, Gemini, Claude, Groq, Azure, Mistral, Ollama, local).
- [ ] Private social network (a company wall): posts, comments, likes across the organisation.

**Identity and infrastructure**
- [ ] Real Active Directory / LDAP sign-in, and SSO.
- [ ] SMTP two-way authentication (2FA by mail) alongside TOTP.
- [ ] Interlink Server: federation between separate servers of the same product.
- [ ] SSL/TLS with your own certificate, including for the browser client; Peach Assist still speaks
      plain HTTP and leaves TLS to a proxy in front of it.
- [ ] MySQL or Microsoft SQL Server backend, running as a Windows service on .NET Framework 4.8;
      Peach Assist is Node plus a single SQLite file.
- [ ] Remote desktop *control*, not just viewing and sharing your own screen.

**Everyday client features**
- [ ] Emoji picker, replies/quoting, keyboard shortcuts and a command palette.
- [ ] Escape messages (short text shown in the tray instead of the chat window).
- [ ] History log view: choose users, keyword and date range, with timestamps and attachments shown.
- [ ] Alerts when a contact's status changes.
- [ ] Contact and group management from the client (add, rename, organise).
- [ ] Notification centre plus desktop notifications.

## 9. Where Peach Assist goes beyond the reference's published list

Everything here is built and exercised in this repository; none of it appears in the reference's
published feature pages as of 2026-11-11.

- **Loadable / unloadable modules** switched only from the admin panel: unloaded features answer
  404 as if never installed, their rail icons vanish live and open copies close.
- **Calendar and time off as two independent modules**, each with its own switch and icon.
- **Unadvertised typed commands** (/nick, /join, /list, /msg, /me, /whois, /invite, /topic, /part)
  with a per-command admin switch; a disabled command reports "unknown command".
- **Searchable teaching manual** at /help (24 chapters, in-page search, print styles) plus a
  downloadable PDF, opened from a rail book icon.
- **Silent sign-in log**: every attempt, success or refusal, with account, name typed, IP,
  reverse DNS, browser, reason and time — admin-only, never shown to the person signing in.
- **Blocking by name, IP, DNS name or any combination**, enforced server-side at the door (403)
  while /health stays open, with an audit entry per block and unblock.
- **Abuse letter generator**: groups refusals by address with names tried, reasons and browsers,
  addresses the letter to admin@your-domain, and offers copy or hand-off to a mail client.
- **Windows Firewall block button** in the panel plus elevated start/stop launchers, so an
  address can be dropped at the firewall as well as by the app.
- **VPN-aware port binding**: asks ProtonVPN's gateway over NAT-PMP for a forwarded port, listens
  on it for TCP and UDP, renews the lease every 45 s, and falls back to 3000. The reference documents
  manual port forwarding (14121–14124) and manual VPN setup instead.
- **HUP reload** and a manual port entry in the panel.
- **Port mapping with no dependencies** (UPnP-IGD and NAT-PMP implemented in-process).

## Build order
1. Foundation: admin panel shell, users/groups/roles, presence + typing + receipts,
   file/image transfer with previews, message search.
2. Rich messaging: polls, acknowledgements, announcements, OTR, preset messages,
   notes, reminders, custom status with auto-reply.
3. Real-time voice/video (WebRTC signalling), screen share, screen clipper, voice
   messages; remote control last.
4. Work: tasks, calendar/meetings, iCal, leave, work hours, reports.
5. Drive, internal mail, helpdesk, API.
6. Hardening: 2FA, LDAP, restrictions, retention, backup/restore, audit log.
