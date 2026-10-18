import { hostname, networkInterfaces } from 'node:os';

const PRIVATE_V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function octets(address) {
  if (typeof address !== 'string') return null;
  const value = address.startsWith('::ffff:') ? address.slice(7) : address;
  const match = PRIVATE_V4.exec(value);
  if (!match) return null;
  const numbers = match.slice(1).map(Number);
  return numbers.some(number => number > 255) ? null : numbers;
}

// Ranges a phone on the same Wi-Fi, hotspot or router reaches this computer
// from. Link-local is included so a direct cable or hotspot still works; the
// benchmarking range some tunnel adapters use is not, since no phone can route
// to it.
export function isPrivateAddress(address) {
  if (isLoopbackAddress(address)) return true;
  const numbers = octets(address);
  if (!numbers) return false;
  const [first, second] = numbers;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254);
}

// The addresses to advertise and to accept in Host, so a virtual adapter or a
// disconnected cable cannot make the printed address wrong.
export function localIPv4Addresses() {
  const found = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const numbers = octets(item.address);
      if (!numbers || (numbers[0] === 169 && numbers[1] === 254)) continue;
      if (isPrivateAddress(item.address)) found.push(item.address);
    }
  }
  return [...new Set(found)];
}

// A tavern page served over the local network: a private address, or this
// computer's own name as the router hands it out.
export function isPrivateOrigin(origin) {
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.protocol !== 'http:') return false;
  const name = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const own = hostname().toLowerCase();
  return isPrivateAddress(name) || name === own || name === `${own}.local`;
}
