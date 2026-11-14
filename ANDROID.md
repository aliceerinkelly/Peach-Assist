# Running the messenger on an Android phone

The product stays a Windows / macOS / Linux install. This is an add-on: the same
server, running on a spare phone, so a household or a small office can put a
messenger on the network without buying a computer for it.

The source is unchanged. What was added is `src/platform.ts`, which makes the
server describe Android's limits instead of failing in ways an operator cannot
read.

## What the code does now

- **Knows it is on Android.** `process.versions.mobile` (set by the embedded
  runtime), `TERMUX_VERSION`, or `ANDROID_ROOT`. Nothing is guessed from a
  hostname or an IP.
- **Refuses a port it cannot have.** Below 1024 an unprivileged Android app gets
  EACCES. The server checks at boot and exits with one plain sentence naming the
  reason and telling the operator to pick 1024 or above and forward that same
  port — rather than dying on a raw error.
- **Says what a certificate costs here.** Port 80 is closed, so HTTP-01 cannot
  work; a DNS challenge (a TXT record, which the IONOS flow already does) is the
  route. The boot banner and the admin panel say so.
- **Reports the machine to the panel.** `/api/net` now carries `machine` and
  `machineNote`, so the network card can name the device it is running on.
- **Storage is already portable.** `DATA_DIR` decides where the database,
  uploads and backups live; on a phone that points into the app's own directory.

## Proving it before packaging anything

Termux needs no APK, no Gradle and no Java, and it answers the questions that
decide whether an APK is worth building at all.

```bash
# In Termux on the phone
pkg update && pkg install nodejs
mkdir -p ~/peach && cd ~/peach
# copy dist/, public/, package.json, package-lock.json from a desktop build
npm install --omit=dev
DATA_DIR=~/peach/data PORT=3000 node dist/server.js
```

Then check, in this order:

1. Does it listen on 3000 and answer `http://127.0.0.1:3000/health`? Proves the
   runtime and the SQLite build.
2. Does another device on the same Wi-Fi reach `http://<phone-ip>:3000`? Proves
   the Wi-Fi stack is not isolating clients.
3. Does the UPnP probe find the router? This is the one that may fail: SSDP is
   multicast, and Android restricts multicast unless the app holds a multicast
   lock (Termux does not). If the router never answers, that is the reason.
4. With a port forwarded by hand in the router, is the phone reachable from a
   device outside the network? Proves the whole path independently of UPnP.

If 1 and 2 work, the APK is packaging. If 3 fails only inside an app shell, the
wrapper needs `WifiManager.MulticastLock`.

## What the APK wrapper has to supply

The Node code cannot do any of this itself — it is all Android-side:

| Requirement | Why | Where it goes |
|---|---|---|
| Foreground service with a persistent notification | Android stops background processes; a server must not be stopped | `Service` + `startForeground` |
| Partial wake lock + battery-optimisation exemption | Doze suspends timers and sockets | `PowerManager.WakeLock`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` |
| `WifiManager.MulticastLock` | UPnP discovery is multicast; without the lock the router is inaudible | before the Node start |
| Embedded runtime | Node is not present on Android | `libnode.so` from nodejs-mobile |
| WebView pointed at `127.0.0.1:3000` | the existing UI, unchanged | `WebView` in the activity |
| `DATA_DIR` set to `getFilesDir()` | private storage, survives updates | process environment before Node starts |

Runtime choice matters: upstream `nodejs-mobile` stopped at Node 18.20.4 and has
no `node:sqlite`, which `src/db.ts` requires. The `digidem` fork builds Node 24
and keeps `node:sqlite` in its **full** (not "lite") artifact. Pin to that.

## Building the APK

The project lives in `android/`. It builds with the toolchain that is already on
this machine:

| Piece | Where |
|---|---|
| JDK 17 | `C:\Users\alice\jdk-17` |
| Android SDK (platform 34, build-tools 34.0.0) | `C:\Users\alice\Android\Sdk` |
| NDK 27.0.12077973 and CMake 3.22.1 | inside the SDK |
| Gradle 8.9 | `C:\Users\alice\tools\gradle-8.9` |
| Node 24.20.0 Android runtime (`libnode.so` + headers) | `C:\Users\alice\tools\nodejs-mobile` |

```bash
cd android
export JAVA_HOME='C:\Users\alice\jdk-17'
/c/Users/alice/tools/gradle-8.9/bin/gradle.bat assembleDebug --no-daemon
# -> app/build/outputs/apk/debug/app-debug.apk  (~25 MB, arm64-v8a)
```

Two things that are easy to get wrong, both already fixed here:

- `local.properties` must use forward slashes (`sdk.dir=C:/Users/...`); escaped
  backslashes make CMake fail with a path-syntax error.
- The project must enable **C++20**. Node 24's headers use `requires`-clauses and
  the NDK defaults to C++17.

Only `arm64-v8a` is packaged, because the runtime is 84 MB per architecture and
nearly every phone since 2017 is arm64. Add `x86_64` to `abiFilters` for an
emulator.

## What will never work on a phone

- **Port 80 and 443.** Closed to unprivileged apps. Certificates come from DNS
  challenges; the site itself runs on an ordinary port.
- **Being a UPS.** A phone plugged in for years, warm, at 100%, is a battery
  risk. Say so in the sales copy rather than discovering it in support.
- **Play Store distribution.** A server foreground service needs justification;
  sideloading the APK avoids the argument entirely and suits "plug in your old
  phone".
