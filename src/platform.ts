/**
 * What kind of machine this is, and what that forbids.
 *
 * The same source runs on Windows, macOS, Linux — and, with an embedded Node,
 * inside an Android app. Android differs in ways that matter to a server: an
 * unprivileged app cannot bind a port below 1024, so a certificate cannot be
 * obtained by answering on port 80, and the process is stopped unless something
 * keeps it awake. The point of this file is that the server says so plainly
 * rather than dying with EACCES.
 *
 * Nothing here is detected by guessing: `process.versions.mobile` is set by the
 * embedded runtime, TERMUX_VERSION by Termux, ANDROID_ROOT by Android itself.
 */

const mobileVersion = (process.versions as Record<string, string | undefined>).mobile || '';
const androidRoot = process.env.ANDROID_ROOT || '';
const termuxVersion = process.env.TERMUX_VERSION || '';

export const onAndroid = process.platform === 'android' || !!androidRoot || !!mobileVersion;
export const isTermux = !!termuxVersion;
export const embeddedNode = !!mobileVersion;

export const platformLabel = onAndroid
  ? 'Android' + (isTermux ? ' (Termux)' : '') + (mobileVersion ? ' — embedded Node ' + mobileVersion : '')
  : process.platform === 'win32'
    ? 'Windows'
    : process.platform === 'darwin'
      ? 'macOS'
      : 'Linux';

/** The first port this process is allowed to open. */
export const lowestOpenPort = onAndroid ? 1024 : 1;

/** Why this port cannot be used here, or null if it can. */
export function portProblem(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return `Port ${port} is not a usable port number.`;
  }
  if (port < lowestOpenPort) {
    return `Port ${port} is below ${lowestOpenPort}: Android gives an app nothing under 1024, so the server cannot listen there. `
      + 'Use a port of 1024 or more, and forward that same port in the router.';
  }
  return null;
}

/** One line for the boot banner, or '' when there is nothing unusual to say. */
export function platformNote(): string {
  if (!onAndroid) return '';
  return 'Android: a certificate has to come from a DNS challenge (a TXT record) rather than by answering on port 80, '
    + 'and the app has to stay in the foreground or Android will stop it.';
}
