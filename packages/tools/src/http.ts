import { lookup as dnsLookup } from 'node:dns/promises';
import { Readable } from 'node:stream';
import { isIP } from 'node:net';

/**
 * Guarded outbound HTTP for the research tools. Everything here fails closed:
 * unknown schemes, credentials in the URL, private/loopback/link-local targets,
 * oversized bodies and disallowed robots rules all refuse instead of guessing.
 */

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 3;
export const MAX_ROBOTS_BYTES = 256 * 1024;

const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/xhtml+xml',
];

export class FetchGuardError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'FetchGuardError';
    this.code = code;
  }
}

export type FetchedPage = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title: string;
  text: string;
  bytes: number;
  truncated: boolean;
  fetchedAt: string;
};

export type FetchOptions = {
  fetchImpl?: typeof fetch;
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  checkRobots?: boolean;
};

type ResolvedLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: ResolvedLookup = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Fetches a URL with the connection pinned to a pre-validated IP address.
 *
 * This is the DNS-rebinding fix. Checking a hostname and then calling `fetch(url)`
 * resolves the name twice: an attacker's resolver can answer "public" the first
 * time and "127.0.0.1" the second, and the socket lands somewhere the guard never
 * saw. `node:http`/`https` accept a `lookup` hook that decides the address at
 * connection time, so the address that was validated is the address dialled.
 *
 * The Host header keeps the original hostname so TLS SNI and virtual hosting still
 * work. Redirects are not followed here — the caller re-validates each hop.
 */
async function fetchPinned(
  target: URL,
  address: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
): Promise<Response> {
  const transport = target.protocol === 'https:' ? await import('node:https') : await import('node:http');
  return new Promise<Response>((resolve, reject) => {
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[/, '').replace(/\]$/, ''),
        port: target.port === '' ? undefined : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: init.headers,
        signal: init.signal,
        // Pin the address: this callback replaces DNS for this socket.
        lookup: (_hostname, _options, callback) => {
          const family = isIP(address);
          callback(null, address, family === 6 ? 6 : 4);
        },
        ...(target.protocol === 'https:' ? { servername: target.hostname } : {}),
      },
      (response) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') headers.set(key, value);
          else if (Array.isArray(value)) headers.set(key, value.join(', '));
        }
        const status = response.statusCode ?? 0;
        // 3xx responses are handed back with an empty body: the caller only needs
        // the Location header, and reading the body of a redirect is wasted work.
        const body = status >= 300 && status < 400 ? null : response;
        resolve(
          new Response(body === null ? null : (Readable.toWeb(body) as ReadableStream), {
            status,
            headers,
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const BLOCKED_V4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/**
 * Extracts an IPv4 address embedded in an IPv6 literal, in either notation:
 * `::ffff:7f00:1` (two hex groups) or `::ffff:127.0.0.1` (dotted).
 */
function embeddedIpv4(address: string): string | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted !== null) return dotted[1] as string;

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (hex === null) return null;
  const high = Number.parseInt(hex[1] as string, 16);
  const low = Number.parseInt(hex[2] as string, 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** True for addresses a public web page can never legitimately live on. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToInt(address);
    if (value === null) return true;
    for (const [base, bits] of BLOCKED_V4_RANGES) {
      const baseValue = ipv4ToInt(base);
      if (baseValue === null) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((value & mask) >>> 0 === (baseValue & mask) >>> 0) return true;
    }
    return false;
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped !== null) return isPrivateAddress(mapped[1] as string);

    // `::ffff:7f00:1` is 127.0.0.1 written in hex, and URL parsing normalises
    // `[::ffff:127.0.0.1]` into exactly that form. The dotted regex above missed it,
    // so loopback and the cloud metadata address were treated as public. Expand any
    // embedded IPv4 in either notation before deciding.
    const embedded = embeddedIpv4(lower);
    if (embedded !== null) return isPrivateAddress(embedded);

    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
    if (lower.startsWith('ff')) return true;
    // 64:ff9b::/96 is IPv4-embedded translation (NAT64); 2002::/16 is 6to4. Both can
    // carry a private IPv4 address to a public-looking IPv6 literal.
    if (lower.startsWith('64:ff9b:')) return true;
    if (lower.startsWith('2002:')) return true;
    return false;
  }
  return true;
}

/** Rejects anything that is not a plain public http(s) URL. */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchGuardError('INVALID_URL', `not a URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchGuardError('BLOCKED_SCHEME', `only http(s) is allowed, got ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new FetchGuardError('BLOCKED_CREDENTIALS', 'URL must not embed credentials');
  }
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new FetchGuardError('BLOCKED_HOST', `local host is not allowed: ${host}`);
  }
  if (isIP(host) !== 0 && isPrivateAddress(host)) {
    throw new FetchGuardError('BLOCKED_HOST', `private address is not allowed: ${host}`);
  }
  return url;
}

/**
 * Resolves a host and refuses it if any address is private.
 *
 * Returns the first public address so the caller can pin the connection to it.
 * Letting `fetch` re-resolve afterwards is the DNS-rebinding hole: the guard sees
 * one answer and the socket gets another.
 */
async function assertResolvable(url: URL, resolve: ResolvedLookup): Promise<string | null> {
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) {
      throw new FetchGuardError('BLOCKED_HOST', `private address is not allowed: ${host}`);
    }
    return host;
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolve(host);
  } catch {
    throw new FetchGuardError('DNS_FAILED', `cannot resolve ${host}`);
  }
  if (addresses.length === 0) throw new FetchGuardError('DNS_FAILED', `no address for ${host}`);
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new FetchGuardError('BLOCKED_HOST', `${host} resolves to a private address`);
    }
  }
  return addresses[0]?.address ?? null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

/** Conservative HTML → text: drops scripts, styles and tags, keeps readable prose. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match === null ? '' : decodeEntities(match[1] as string).trim().slice(0, 200);
}

async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (response.body === null) return { text: '', bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, remaining));
      total += remaining;
      truncated = true;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  if (truncated) await reader.cancel().catch(() => undefined);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder('utf-8').decode(merged), bytes: total, truncated };
}

function robotsDisallows(robots: string, path: string): boolean {
  const lines = robots.split(/\r?\n/).map((line) => line.replace(/#.*$/, '').trim());
  let applies = false;
  const disallow: string[] = [];
  for (const line of lines) {
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = (match[1] as string).toLowerCase();
    const value = (match[2] as string).trim();
    if (key === 'user-agent') {
      applies = value === '*';
      continue;
    }
    if (!applies) continue;
    if (key === 'disallow' && value !== '') disallow.push(value);
  }
  if (disallow.length === 0) return false;
  return disallow.some((rule) => path.startsWith(rule));
}

async function checkRobots(url: URL, options: Required<Pick<FetchOptions, 'fetchImpl'>> & FetchOptions, resolve: ResolvedLookup): Promise<void> {
  const robotsUrl = new URL('/robots.txt', url.origin);
  await assertPublicUrl(robotsUrl.toString());
  // robots.txt is fetched before the main request, so it needs the same DNS guard
  // or a hostname resolving to loopback would still be reached through it.
  await assertResolvable(robotsUrl, resolve);
  let response: Response;
  try {
    response = await options.fetchImpl(robotsUrl.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
      headers: { 'user-agent': 'CreatorStudioBot/0.5 (+local research tool)' },
    });
  } catch {
    return;
  }
  if (!response.ok) return;
  const body = await readCapped(response, MAX_ROBOTS_BYTES);
  if (robotsDisallows(body.text, `${url.pathname}${url.search}`)) {
    throw new FetchGuardError('ROBOTS_DISALLOWED', `robots.txt disallows ${url.pathname}`);
  }
}

/** Fetches one public page with every guard applied; throws FetchGuardError on refusal. */
export async function fetchPage(rawUrl: string, options: FetchOptions = {}): Promise<FetchedPage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolve = options.lookup ?? defaultLookup;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let current = assertPublicUrl(rawUrl);
  await assertResolvable(current, resolve);
  if (options.checkRobots !== false) {
    await checkRobots(current, { fetchImpl }, resolve);
  }

  let response: Response | null = null;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const pinnedAddress = await assertResolvable(current, resolve);
    let hopResponse: Response;
    try {
      const requestHeaders = {
        'user-agent': 'CreatorStudioBot/0.5 (+local research tool)',
        accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1',
      };
      // With the built-in fetch, pin the socket to the validated address. A custom
      // fetchImpl (tests) is already responsible for its own transport.
      hopResponse =
        pinnedAddress !== null && options.fetchImpl === undefined
          ? await fetchPinned(current, pinnedAddress, { signal: AbortSignal.timeout(timeoutMs), headers: requestHeaders })
          : await fetchImpl(current.toString(), {
              redirect: 'manual',
              signal: AbortSignal.timeout(timeoutMs),
              headers: requestHeaders,
            });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'network failure';
      throw new FetchGuardError('NETWORK_ERROR', message);
    }
    if (hopResponse.status >= 300 && hopResponse.status < 400) {
      const location = hopResponse.headers.get('location');
      if (location === null) throw new FetchGuardError('BAD_REDIRECT', 'redirect without location');
      current = assertPublicUrl(new URL(location, current).toString());
      continue;
    }
    response = hopResponse;
    break;
  }
  if (response === null) throw new FetchGuardError('TOO_MANY_REDIRECTS', `more than ${maxRedirects} redirects`);

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.some((allowed) => contentType.startsWith(allowed))) {
    throw new FetchGuardError('BLOCKED_CONTENT_TYPE', `unsupported content type: ${contentType || 'unknown'}`);
  }

  const body = await readCapped(response, maxBytes);
  const isHtml = contentType.startsWith('text/html') || contentType.startsWith('application/xhtml');
  const text = isHtml ? htmlToText(body.text) : body.text.trim();
  return {
    url: rawUrl,
    finalUrl: current.toString(),
    status: response.status,
    contentType: contentType.split(';')[0] ?? contentType,
    title: isHtml ? extractTitle(body.text) : '',
    text,
    bytes: body.bytes,
    truncated: body.truncated,
    fetchedAt: new Date().toISOString(),
  };
}
