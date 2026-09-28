import type { IncomingMessage } from 'node:http';
import { BlockList, isIP, SocketAddress } from 'node:net';

/** Addresses are trust inputs, never hostnames, aliases, or a hop-count policy. */
export function trustedProxyPolicy(cidrs: readonly string[]): (address: string) => boolean {
  const allowed = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefix] = cidr.split('/');
    const family = isIP(address!) === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) allowed.addAddress(address!, family);
    else allowed.addSubnet(address!, Number(prefix), family);
  }
  return (address) => {
    const family = isIP(address);
    return (
      family !== 0 &&
      !address.includes('%') &&
      allowed.check(address, family === 4 ? 'ipv4' : 'ipv6')
    );
  };
}

/** Called only when the immediate socket peer is trusted; other forwarding is ignored. */
export function validForwardedFor(request: IncomingMessage): boolean {
  const forwarded = request.headers['x-forwarded-for'];
  if (forwarded === undefined) return true;
  let headers = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === 'x-forwarded-for') headers += 1;
  }
  if (headers !== 1 || typeof forwarded !== 'string' || forwarded.length > 1024) return false;
  const addresses = forwarded.split(',').map((address) => address.trim());
  return (
    addresses.length <= 16 &&
    addresses.every((address) => isIP(address) !== 0 && !address.includes('%'))
  );
}

/** Equivalent IPv6 spellings and IPv4-mapped addresses share one limiter identity. */
export function canonicalClientIp(address: string): string {
  const family = isIP(address);
  if (family === 0 || address.includes('%')) throw new Error('INVALID_CLIENT_IP');
  const normalized = SocketAddress.parse(family === 6 ? `[${address}]:0` : `${address}:0`);
  if (normalized === undefined) throw new Error('INVALID_CLIENT_IP');
  return normalized.address.startsWith('::ffff:')
    ? normalized.address.slice('::ffff:'.length)
    : normalized.address;
}
