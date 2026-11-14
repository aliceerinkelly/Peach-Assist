/**
 * Router port mapping without dependencies.
 *
 * Two paths are tried, in order:
 *   1. UPnP-IGD  (SSDP discovery + SOAP AddPortMapping) — what most home routers speak
 *   2. NAT-PMP   (UDP 5351 to the default gateway)     — Apple and some others
 *
 * Both are best-effort: a router may refuse, be disabled, or the ISP may be doing
 * CGNAT, in which case no mapping helps. Nothing here throws to the caller.
 */
import dgram from 'node:dgram';
import { exec } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';

export type MappingResult = {
  ok: boolean;
  method: 'upnp' | 'natpmp' | null;
  externalPort?: number;
  publicIp?: string;
  publicUrl?: string;
  error?: string;
};

/* ------------------------------------------------------------------ */
/* network facts                                                       */
/* ------------------------------------------------------------------ */

export function localIPv4(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

/**
 * Every IPv4 address this machine holds, VPN tunnel included.
 *
 * Discovery has to ask once per address: a socket bound to the tunnel can
 * never reach the home router, and a socket bound to the LAN card can never
 * reach the VPN gateway.
 */
export function localIPv4s(): string[] {
  const found: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) found.push(ni.address);
    }
  }
  return found.length ? found : ['127.0.0.1'];
}

/**
 * The router's address, asked of the operating system in every way that works.
 *
 * Android is the awkward one: an app cannot run `ip route`, and recent versions
 * refuse /proc/net/route too, so a phone often gets nothing at all. That is why
 * gatewayCandidates() below also works one out from our own address.
 */
export function defaultGateway(): Promise<string | null> {
  const fromProc = (): string | null => {
    try {
      const txt = fs.readFileSync('/proc/net/route', 'utf8');
      for (const line of txt.split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 3 || f[1] !== '00000000') continue;
        const hex = f[2];
        if (!/^[0-9a-fA-F]{8}$/.test(hex)) continue;
        return [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)]
          .map((part) => parseInt(part, 16)).join('.');
      }
    } catch { /* not readable here */ }
    return null;
  };

  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'route print -4 0.0.0.0' : 'ip route';
    exec(cmd, { timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) { resolve(fromProc()); return; }
      if (process.platform === 'win32') {
        // 0.0.0.0  0.0.0.0  <gateway>  <iface>
        const m = stdout.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/m);
        resolve(m ? m[1] : null);
      } else {
        const m = stdout.match(/default via (\d+\.\d+\.\d+\.\d+)/);
        resolve(m ? m[1] : fromProc());
      }
    });
  });
}

/**
 * Every address the router could plausibly be at, best guess first.
 *
 * On a phone the routing table is out of reach, but the router is almost always
 * one hop off our own subnet: for 10.0.0.215 that is 10.0.0.1. An address typed
 * in the panel wins over all of it.
 */
export async function gatewayCandidates(): Promise<string[]> {
  const list: string[] = [];
  const add = (value?: string | null) => {
    const ip = String(value || '').trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !list.includes(ip)) list.push(ip);
  };

  add(process.env.GATEWAY);
  add(await defaultGateway());
  for (const ip of localIPv4s()) {
    const parts = ip.split('.');
    if (parts.length !== 4) continue;
    const base = parts.slice(0, 3).join('.');
    add(base + '.1');
    add(base + '.254');
  }
  add('192.168.1.1');
  add('192.168.0.1');
  return list;
}

/* ------------------------------------------------------------------ */
/* NAT-PMP                                                             */
/* ------------------------------------------------------------------ */

function natPmpRequest(gateway: string, packet: Buffer, expectLen: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (v: Buffer | null) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* ignore */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 1600);

    sock.on('message', (msg) => {
      clearTimeout(timer);
      finish(msg.length >= expectLen ? msg : null);
    });
    sock.on('error', () => { clearTimeout(timer); finish(null); });
    sock.send(packet, 5351, gateway, () => { /* errors surface via 'error' */ });
  });
}

async function tryNatPmp(port: number): Promise<MappingResult> {
  // The routing table is unreadable on Android; the first candidate is the
  // address typed in the panel, then our own subnet, then the usual suspects.
  const gateway = (await gatewayCandidates())[0] || null;
  if (!gateway) return { ok: false, method: null, error: 'no default gateway found' };

  // opcode 0: external address, so we know the public IP.
  const addr = await natPmpRequest(gateway, Buffer.from([0, 0]), 12);
  if (!addr || addr[1] !== 0x80 || addr.readUInt16BE(2) !== 0) {
    return { ok: false, method: null, error: 'router did not answer NAT-PMP' };
  }
  const ip = `${addr[8]}.${addr[9]}.${addr[10]}.${addr[11]}`;

  // opcode 2: map TCP, internal port == external port, 1 hour lease.
  const req = Buffer.alloc(12);
  req[0] = 0; req[1] = 2;
  req.writeUInt16BE(port, 4);
  req.writeUInt16BE(port, 6);
  req.writeUInt32BE(3600, 8);

  const mapped = await natPmpRequest(gateway, req, 16);
  if (!mapped || mapped[1] !== 0x82 || mapped.readUInt16BE(2) !== 0) {
    return { ok: false, method: null, publicIp: ip, error: 'NAT-PMP mapping refused' };
  }
  const externalPort = mapped.readUInt16BE(10);
  return {
    ok: true,
    method: 'natpmp',
    externalPort,
    publicIp: ip,
    publicUrl: `http://${ip}:${externalPort}`,
  };
}

/* ------------------------------------------------------------------ */
/* UPnP-IGD                                                            */
/* ------------------------------------------------------------------ */

type Igd = { controlUrl: string; serviceType: string; localIp: string };

function parseXmlTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

const SSDP_SEARCHES = ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'ssdp:all'].map((st) =>
  Buffer.from(
    'M-SEARCH * HTTP/1.1\r\n' +
    'HOST: 239.255.255.250:1900\r\n' +
    'MAN: "ssdp:discover"\r\n' +
    'MX: 2\r\n' +
    'ST: ' + st + '\r\n\r\n'
  )
);

/**
 * One SSDP round. `bindTo` picks the socket's local address; null means "any",
 * which is what Android needs — binding the multicast socket to the Wi-Fi
 * address there means the search never leaves the phone, a restriction the
 * desktop does not have. Retries are spaced out because a phone's Wi-Fi stack
 * parks itself between packets and silently drops the first one.
 */
function ssdpSearch(bindTo: string | null, multicastInterface: string, windowMs: number, target = '239.255.255.250'): Promise<string[]> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Set<string>();
    let closed = false;
    let sent = 0;

    const done = () => {
      if (closed) return;
      closed = true;
      clearInterval(ticker);
      try { sock.close(); } catch { /* already gone */ }
      resolve([...found]);
    };

    sock.on('message', (msg) => {
      const m = msg.toString('utf8').match(/^location:\s*(.+)$/im);
      if (m) found.add(m[1].trim());
    });
    sock.on('error', done);

    const send = () => {
      if (closed) return;
      sent++;
      try {
        sock.setBroadcast(true);
        try { sock.setMulticastInterface(multicastInterface); } catch { /* not fatal */ }
        for (const search of SSDP_SEARCHES) {
          sock.send(search, 1900, target);
        }
      } catch { /* the next round may still get out */ }
    };

    const ticker = setInterval(() => { if (sent < 4) send(); }, 700);
    const start = () => { send(); setTimeout(send, 250); };
    if (bindTo) sock.bind(0, bindTo, start);
    else sock.bind(0, start);

    setTimeout(done, windowMs);
  });
}

async function discoverIgd(localIp: string, note: (msg: string) => void = console.log): Promise<Igd | null> {
  const locations = new Set<string>();
  // Bound to the interface first (the desktop case, and the only way to keep a
  // VPN tunnel from swallowing the search), then unbound (the Android case).
  for (const bindTo of [localIp, null]) {
    const answers = await ssdpSearch(bindTo, localIp, 2200);
    for (const a of answers) locations.add(a);
    note(`  UPnP: ${answers.length} answer(s) from the ${bindTo ? 'interface-bound' : 'default'} multicast search`);
    if (locations.size) break;
  }

  // Multicast is the polite way and the one Android restricts. Some phones will
  // not let a broadcast out at all, so ask the gateway directly as well — a
  // question sent to one address cannot be filtered as "multicast".
  if (!locations.size) {
    const candidates = (await gatewayCandidates()).slice(0, 3);
    note('  UPnP: multicast heard nothing; asking directly: ' + (candidates.join(', ') || 'no address to try'));
    for (const gateway of candidates) {
      const answers = await ssdpSearch(null, localIp, 1800, gateway);
      for (const a of answers) locations.add(a);
      note(`  UPnP: ${answers.length} answer(s) from the direct search to ${gateway}`);
      if (locations.size) break;
    }
  }

  for (const loc of locations) {
    try {
      const res = await fetch(loc, { signal: AbortSignal.timeout(4000) });
      const xml = await res.text();
      const base = new URL(loc);
      const services = xml.match(/<service>[\s\S]*?<\/service>/gi) || [];
      for (const svc of services) {
        const type = parseXmlTag(svc, 'serviceType') || '';
        if (!/WAN(IP|PPP)Connection:1/.test(type)) continue;
        const control = parseXmlTag(svc, 'controlURL');
        if (!control) continue;
        const controlUrl = new URL(control, base).toString();
        return { controlUrl, serviceType: type, localIp };
      }
    } catch { /* try the next location */ }
  }
  return null;
}

type SoapReply = { ok: boolean; status: number; body: string; fault: string };

/** Pull the router's own words out of a SOAP fault, e.g. "718 ConflictInMappingEntry". */
function soapFault(body: string): string {
  const code = body.match(/<errorCode>\s*(\d+)\s*<\/errorCode>/i);
  const desc = body.match(/<errorDescription>\s*([^<]+?)\s*<\/errorDescription>/i);
  if (!code && !desc) return '';
  return [code && code[1], desc && desc[1]].filter(Boolean).join(' ');
}

async function soapReply(igd: Igd, action: string, body: string): Promise<SoapReply> {
  const envelope =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${igd.serviceType}">${body}</u:${action}></s:Body></s:Envelope>`;
  try {
    const res = await fetch(igd.controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${igd.serviceType}#${action}"`,
      },
      body: envelope,
      signal: AbortSignal.timeout(6000),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text, fault: res.ok ? '' : soapFault(text) };
  } catch (err) {
    return { ok: false, status: 0, body: '', fault: (err as Error)?.message || 'no answer' };
  }
}

function mappingBody(external: number, internal: number, client: string): string {
  return '<NewRemoteHost></NewRemoteHost>' +
    `<NewExternalPort>${external}</NewExternalPort>` +
    '<NewProtocol>TCP</NewProtocol>' +
    `<NewInternalPort>${internal}</NewInternalPort>` +
    `<NewInternalClient>${client}</NewInternalClient>` +
    '<NewEnabled>1</NewEnabled>' +
    '<NewPortMappingDescription>Messenger</NewPortMappingDescription>' +
    '<NewLeaseDuration>3600</NewLeaseDuration>';
}

/**
 * Ask for a mapping and deal with a router that says no.
 *
 * The usual refusal is 718 ConflictInMappingEntry: some other machine on the
 * network already holds that external port (an older install, a game, another
 * copy of this app). Clearing the stale rule and asking again fixes most of
 * those; if the port is genuinely taken we walk up a few numbers and use the
 * first the router grants, which is why the reported external port can differ
 * from the port we listen on.
 */
async function mapPort(igd: Igd, port: number, preferredExternal = 0): Promise<{ ok: boolean; externalPort: number; fault: string }> {
  // What the panel asked for first, then the neighbours, then 4000 — a number
  // no chat app, NAS or game console on a home network has usually claimed.
  const wanted = [preferredExternal || port, port + 1, port + 2, port + 3, 4000]
    .filter((n, i, all) => n >= 1 && n <= 65535 && all.indexOf(n) === i);
  let fault = '';

  for (let i = 0; i < wanted.length; i++) {
    const ext = wanted[i];
    if (i === 0) {
      // Clear a leftover rule on the same port that points somewhere else.
      await soapReply(igd, 'DeletePortMapping',
        '<NewRemoteHost></NewRemoteHost>' +
        `<NewExternalPort>${ext}</NewExternalPort>` +
        '<NewProtocol>TCP</NewProtocol>');
    }
    const reply = await soapReply(igd, 'AddPortMapping', mappingBody(ext, port, igd.localIp));
    if (reply.ok) return { ok: true, externalPort: ext, fault: '' };
    fault = reply.fault || `HTTP ${reply.status}`;
    // Only a clash is worth trying another number for.
    if (!/^7/.test(fault)) break;
  }
  return { ok: false, externalPort: port, fault };
}

async function soap(igd: Igd, action: string, body: string): Promise<string | null> {
  const envelope =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${igd.serviceType}">${body}</u:${action}></s:Body></s:Envelope>`;
  try {
    const res = await fetch(igd.controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${igd.serviceType}#${action}"`,
      },
      body: envelope,
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    return res.ok ? text : null;
  } catch {
    return null;
  }
}

async function tryUpnp(port: number): Promise<MappingResult> {
  const candidates = localIPv4s();
  const answers = await Promise.all(candidates.map((ip) => discoverIgd(ip)));
  const igd = answers.find((a) => a !== null) || null;
  if (!igd) return { ok: false, method: null, error: 'no UPnP gateway answered' };

  const mapping = await mapPort(igd, port, Number(process.env.EXTERNAL_PORT || 0) || 0);
  if (!mapping.ok) {
    return {
      ok: false,
      method: null,
      error: 'router refused the port mapping' + (mapping.fault ? ': ' + mapping.fault : ''),
    };
  }

  const ipXml = await soap(igd, 'GetExternalIPAddress', '');
  const publicIp = ipXml ? parseXmlTag(ipXml, 'NewExternalIPAddress') : null;
  const usable = publicIp && /^\d+\.\d+\.\d+\.\d+$/.test(publicIp) && publicIp !== '0.0.0.0';
  return {
    ok: true,
    method: 'upnp',
    externalPort: mapping.externalPort,
    publicIp: usable ? publicIp! : undefined,
    publicUrl: usable ? `http://${publicIp}:${mapping.externalPort}` : undefined,
  };
}

export type RouterCheckResult = {
  ok: boolean;
  lines: string[];
  controlUrl?: string;
  publicIp?: string;
  error?: string;
};

/**
 * The whole conversation with the router, step by step, for someone looking at
 * the panel instead of a terminal. Same code paths as the real mapping, so what
 * it reports is what actually happens at boot.
 */
export async function routerCheck(port: number): Promise<RouterCheckResult> {
  const lines: string[] = [];
  const note = (msg: string) => { lines.push(String(msg).replace(/^\s+/, '')); };

  const localIps = localIPv4s();
  note('This machine: ' + (localIps.join(', ') || 'no LAN address found'));
  note('Will ask: ' + ((await gatewayCandidates()).join(', ') || 'nobody — no address to try'));

  let igd: Igd | null = null;
  for (const ip of localIps) {
    igd = await discoverIgd(ip, note);
    if (igd) break;
  }
  if (!igd) {
    note('No router answered. The phone is not reaching 10.0.0.1 on port 1900.');
    return { ok: false, lines, error: 'no UPnP gateway answered' };
  }
  note('Router spoke UPnP. Control URL: ' + igd.controlUrl);

  const preferred = Number(process.env.EXTERNAL_PORT || 0) || 0;
  if (preferred) note(`You asked for public port ${preferred}.`);
  const mapping = await mapPort(igd, port, preferred);
  if (!mapping.ok) {
    note(`The router answered but refused to forward TCP ${preferred || port}` +
      (mapping.fault ? `: ${mapping.fault}` : '.'));
    if (/^7/.test(mapping.fault)) {
      note('That is a clash: another device or an older rule holds the port. Clear it in the router, or the app tries the next number up.');
    }
    return { ok: false, lines, controlUrl: igd.controlUrl, error: 'router refused the port mapping: ' + mapping.fault };
  }
  const asked = preferred || port;
  note(mapping.externalPort === asked
    ? `Forwarded TCP ${mapping.externalPort} to ${igd.localIp} on port ${port}.`
    : `Forwarded TCP ${mapping.externalPort} to ${igd.localIp} on port ${port} (${asked} was taken).`);

  const ipXml = await soap(igd, 'GetExternalIPAddress', '');
  const publicIp = ipXml ? parseXmlTag(ipXml, 'NewExternalIPAddress') || undefined : undefined;
  note('The router says the public address is: ' + (publicIp || 'not reported'));
  return { ok: true, lines, controlUrl: igd.controlUrl, publicIp };
}

/* ------------------------------------------------------------------ */
/* VPN detection                                                       */
/* ------------------------------------------------------------------ */

export type VpnInfo = {
  addresses: { name: string; address: string }[];
  ports: number[];
};

const VPN_NAME = /^(tun|tap|wg|utun|ipsec|ppp|tailscale|zerotier|nordlynx|proton|mullvad)/i;
const VPN_PORTS = [
  { port: 51820, proto: 'udp', label: 'WireGuard' },
  { port: 51821, proto: 'udp', label: 'WireGuard (alt)' },
  { port: 1194, proto: 'tcp', label: 'OpenVPN' },
  { port: 500, proto: 'udp', label: 'IPsec IKE' },
  { port: 4500, proto: 'udp', label: 'IPsec NAT-T' },
  { port: 1723, proto: 'tcp', label: 'PPTP' },
];

/** Tailscale hands out addresses in 100.64.0.0/10, which is never a LAN. */
function isCgnatRange(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

export function vpnAddresses(): { name: string; address: string }[] {
  const out: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (VPN_NAME.test(name) || isCgnatRange(ni.address)) {
        out.push({ name, address: ni.address });
      }
    }
  }
  return out;
}

/** VPN daemons listen on well-known ports; report any that are open on this machine. */
function vpnListeners(): Promise<number[]> {
  return new Promise((resolve) => {
    exec('netstat -ano', { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) { resolve([]); return; }
      const found: number[] = [];
      for (const entry of VPN_PORTS) {
        const re = new RegExp(`[:.]${entry.port}\\s+\\S+\\s+(LISTENING|\\*:\\*)`, 'i');
        if (re.test(stdout)) found.push(entry.port);
      }
      resolve(found);
    });
  });
}

export async function detectVpn(): Promise<VpnInfo> {
  return { addresses: vpnAddresses(), ports: await vpnListeners() };
}

export type VpnPortInfo = {
  ok: boolean;
  port?: number;
  externalPort?: number;
  gateway?: string;
  publicIp?: string;
  tcp?: boolean;
  udp?: boolean;
  error?: string;
};

/** NAT-PMP: opcode 1 maps UDP, opcode 2 maps TCP. */
function mapPacket(opcode: 1 | 2, internal: number, external: number): Buffer {
  const b = Buffer.alloc(12);
  b[0] = 0;
  b[1] = opcode;
  b.writeUInt16BE(internal, 4);
  b.writeUInt16BE(external, 6);
  b.writeUInt32BE(3600, 8);
  return b;
}

/**
 * Ask the VPN's own gateway which port it forwards to this machine.
 *
 * A VPN's own gateway answers NAT-PMP, the same trick a torrent client uses to
 * learn its port. Which gateway that is belongs to the tunnel, so it is taken
 * from the machine: `VPN_GATEWAY` if set, otherwise whatever route the tunnel
 * installed as the default. Nothing here is specific to one provider.
 * TCP and UDP are both requested so the mapping covers either protocol. Never
 * throws: no forwarding simply means `ok: false` and the caller stays on its
 * normal port.
 */
export async function vpnForwardedPort(preferred = 0): Promise<VpnPortInfo> {
  const gateways: string[] = [];
  const add = (g?: string | null) => { if (g && !gateways.includes(g)) gateways.push(g); };
  add(process.env.VPN_GATEWAY);
  add(await defaultGateway());

  const parse = (b: Buffer | null, op: number) => {
    if (!b || b[1] !== op || b.readUInt16BE(2) !== 0 || b.length < 16) return null;
    return { internal: b.readUInt16BE(8), external: b.readUInt16BE(10), life: b.readUInt32BE(12) };
  };

  let lastError = 'no VPN gateway answered NAT-PMP';
  for (const gateway of gateways) {
    const addr = await natPmpRequest(gateway, Buffer.from([0, 0]), 12);
    if (!addr || addr[1] !== 0x80 || addr.readUInt16BE(2) !== 0) {
      lastError = `no NAT-PMP answer from ${gateway}`;
      continue;
    }
    const publicIp = `${addr[8]}.${addr[9]}.${addr[10]}.${addr[11]}`;

    // "Any port" is the request that matters: ProtonVPN then grants one number
    // and maps it to itself, so the server can listen on exactly that number.
    let tcp = parse(await natPmpRequest(gateway, mapPacket(2, 0, 0), 16), 0x82);
    if (!tcp && preferred) {
      tcp = parse(await natPmpRequest(gateway, mapPacket(2, preferred, 0), 16), 0x82);
    }
    if (!tcp || !tcp.external) { lastError = `NAT-PMP refused a mapping on ${gateway}`; continue; }

    // Same number over UDP so peer-to-peer style traffic is covered too.
    const udp = parse(await natPmpRequest(gateway, mapPacket(1, tcp.internal, tcp.external), 16), 0x81);

    return {
      ok: true,
      port: tcp.internal,
      externalPort: tcp.external,
      gateway,
      publicIp,
      tcp: true,
      udp: !!udp,
    };
  }
  return { ok: false, error: lastError };
}

/** Renew a VPN mapping before its short lease runs out, keeping the number stable. */
export async function renewVpnMapping(gateway: string, port: number): Promise<{ ok: boolean; externalPort?: number; error?: string }> {
  const tcp = await natPmpRequest(gateway, mapPacket(2, port, 0), 16);
  if (!tcp || tcp[1] !== 0x82 || tcp.readUInt16BE(2) !== 0) return { ok: false, error: 'renew refused' };
  await natPmpRequest(gateway, mapPacket(1, port, 0), 16);
  return { ok: true, externalPort: tcp.readUInt16BE(10) };
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Take back a mapping this process put on the home router.
 * Used when the public path changes at runtime and the rule is no longer wanted.
 */
export async function removeUpnpMapping(port: number): Promise<boolean> {
  const answers = await Promise.all(localIPv4s().map((ip) => discoverIgd(ip)));
  const igd = answers.find((a) => a !== null) || null;
  if (!igd) return false;
  const result = await soap(igd, 'DeletePortMapping',
    '<NewRemoteHost></NewRemoteHost>' +
    `<NewExternalPort>${port}</NewExternalPort>` +
    '<NewProtocol>TCP</NewProtocol>');
  return result !== null;
}

/**
 * Read-only look at the router: does anything answer UPnP discovery, and what
 * address does it think it has?
 *
 * It maps nothing, so a setup check can call it without changing the router.
 * A gateway that answers but reports a private address is the carrier-grade NAT
 * case: forwarding is impossible no matter how the app is configured.
 */
export async function upnpProbe(): Promise<{ answered: boolean; localIp: string; externalIp?: string }> {
  const addresses = localIPv4s();
  const answers = await Promise.all(addresses.map((ip) => discoverIgd(ip)));
  const igd = answers.find((a) => a !== null) || null;
  if (!igd) return { answered: false, localIp: addresses[0] || '' };
  const xml = await soap(igd, 'GetExternalIPAddress', '');
  const externalIp = xml ? parseXmlTag(xml, 'NewExternalIPAddress') || undefined : undefined;
  return { answered: true, localIp: igd.localIp, externalIp };
}

export async function openPort(port: number): Promise<MappingResult> {
  // NAT-PMP first: it is one small UDP exchange and far quicker to fail.
  try {
    const pmp = await tryNatPmp(port);
    if (pmp.ok) return pmp;
    const upnp = await tryUpnp(port);
    if (upnp.ok) return upnp;
    return { ok: false, method: null, error: `${pmp.error}; ${upnp.error}` };
  } catch (err: any) {
    return { ok: false, method: null, error: err?.message || String(err) };
  }
}
