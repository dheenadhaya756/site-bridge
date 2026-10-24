import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

const okHosts = new Set();

/** Rejects non-http(s) URLs and hosts that resolve to private networks (SSRF guard). */
export async function assertPublicUrl(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are supported');
  if (config.allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (okHosts.has(host)) return u;
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Local addresses cannot be scanned');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) {
    throw new Error('That address points to a private network and cannot be scanned');
  }
  okHosts.add(host);
  return u;
}

export function bareHost(hostname) {
  return hostname.toLowerCase().replace(/^www\./, '');
}

export function sameSite(hostname, siteHostname) {
  return bareHost(hostname) === bareHost(siteHostname);
}
