import { describe, expect, it } from 'vitest';
import {
  FetchGuardError,
  assertPublicUrl,
  extractTitle,
  fetchPage,
  htmlToText,
  isPrivateAddress,
} from '../src/http.js';

const noRobots = async () => {
  throw new FetchGuardError('DNS_FAILED', 'tests never hit the network');
};

function fakeResponse(body: string, init: { status?: number; contentType?: string; headers?: Record<string, string> } = {}): Response {
  const headers = new Headers({ 'content-type': init.contentType ?? 'text/html; charset=utf-8', ...(init.headers ?? {}) });
  return new Response(body, { status: init.status ?? 200, headers });
}

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '10.1.2.3', family: 4 }];

describe('R1 private address detection', () => {
  it('rejects loopback, RFC1918, link-local and mapped addresses', () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '172.16.4.2', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('accepts public addresses', () => {
    for (const address of ['93.184.216.34', '1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe('R2 URL scheme and host guards', () => {
  it('accepts a plain public https URL', () => {
    expect(assertPublicUrl('https://example.com/page').hostname).toBe('example.com');
  });

  it('rejects non-http schemes', () => {
    expect(() => assertPublicUrl('file:///etc/passwd')).toThrow(/BLOCKED_SCHEME/);
    expect(() => assertPublicUrl('ftp://example.com/x')).toThrow(/BLOCKED_SCHEME/);
    expect(() => assertPublicUrl('javascript:alert(1)')).toThrow(/BLOCKED_SCHEME/);
  });

  it('rejects embedded credentials', () => {
    expect(() => assertPublicUrl('https://user:pass@example.com/')).toThrow(/BLOCKED_CREDENTIALS/);
  });

  it('rejects localhost and private literals', () => {
    for (const url of ['http://localhost:3000', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://intranet.local/']) {
      expect(() => assertPublicUrl(url), url).toThrow(/BLOCKED_HOST/);
    }
  });
});

describe('R3 fetch guards', () => {
  it('refuses when the hostname resolves to a private address', async () => {
    await expect(
      fetchPage('https://internal.example.com/', {
        fetchImpl: async () => fakeResponse('x'),
        lookup: privateLookup,
        checkRobots: false,
      }),
    ).rejects.toThrow(/BLOCKED_HOST/);
  });

  it('refuses an unsupported content type', async () => {
    await expect(
      fetchPage('https://example.com/a.pdf', {
        fetchImpl: async () => fakeResponse('%PDF', { contentType: 'application/pdf' }),
        lookup: publicLookup,
        checkRobots: false,
      }),
    ).rejects.toThrow(/BLOCKED_CONTENT_TYPE/);
  });

  it('re-validates each redirect hop and refuses a redirect into private space', async () => {
    let calls = 0;
    await expect(
      fetchPage('https://example.com/start', {
        fetchImpl: async () => {
          calls += 1;
          return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
        },
        lookup: publicLookup,
        checkRobots: false,
      }),
    ).rejects.toThrow(/BLOCKED_HOST/);
    expect(calls).toBe(1);
  });

  it('stops after the redirect budget', async () => {
    let calls = 0;
    await expect(
      fetchPage('https://example.com/loop', {
        fetchImpl: async () => {
          calls += 1;
          return new Response(null, { status: 302, headers: { location: 'https://example.com/loop' } });
        },
        lookup: publicLookup,
        maxRedirects: 2,
        checkRobots: false,
      }),
    ).rejects.toThrow(/TOO_MANY_REDIRECTS/);
    expect(calls).toBe(3);
  });

  it('truncates an oversized body instead of buffering it all', async () => {
    const big = 'a'.repeat(5_000);
    const page = await fetchPage('https://example.com/big', {
      fetchImpl: async () => fakeResponse(big, { contentType: 'text/plain' }),
      lookup: publicLookup,
      maxBytes: 1_000,
      checkRobots: false,
    });
    expect(page.bytes).toBe(1_000);
    expect(page.truncated).toBe(true);
  });

  it('applies the DNS guard to the robots probe too', async () => {
    // A hostname that resolves to loopback must be refused before robots.txt is
    // ever requested, otherwise the probe itself would reach the private host.
    let robotsProbed = false;
    await expect(
      fetchPage('https://internal.example.com/', {
        fetchImpl: async (input) => {
          if (String(input).endsWith('/robots.txt')) robotsProbed = true;
          return fakeResponse('x');
        },
        lookup: privateLookup,
      }),
    ).rejects.toThrow(/BLOCKED_HOST/);
    expect(robotsProbed).toBe(false);
  });

  it('honours robots.txt disallow rules', async () => {
    await expect(
      fetchPage('https://example.com/private/secret', {
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith('/robots.txt')) {
            return fakeResponse('User-agent: *\nDisallow: /private\n', { contentType: 'text/plain' });
          }
          return fakeResponse('<html><body>secret</body></html>');
        },
        lookup: publicLookup,
      }),
    ).rejects.toThrow(/ROBOTS_DISALLOWED/);
  });

  it('returns readable text and metadata for an allowed page', async () => {
    const page = await fetchPage('https://example.com/article', {
      fetchImpl: async () =>
        fakeResponse('<html><head><title>示例标题</title><style>.x{}</style></head><body><h1>Heading</h1><p>正文 &amp; 内容</p><script>alert(1)</script></body></html>'),
      lookup: publicLookup,
      checkRobots: false,
    });
    expect(page.title).toBe('示例标题');
    expect(page.text).toContain('Heading');
    expect(page.text).toContain('正文 & 内容');
    expect(page.text).not.toContain('alert(1)');
    expect(page.text).not.toContain('.x{}');
  });

  it('reports DNS failures without leaking internals', async () => {
    await expect(
      fetchPage('https://nope.example.com/', {
        fetchImpl: async () => fakeResponse('x'),
        lookup: noRobots,
        checkRobots: false,
      }),
    ).rejects.toThrow(/DNS_FAILED/);
  });
});

// Regression from a real environment: a TUN-mode proxy answered DNS for every
// public name with 198.18.x.x, and the guard refused example.com. That is correct
// behaviour — 198.18.0.0/15 is reserved for benchmarking and must never appear as
// a public target — so the behaviour is pinned here rather than relaxed.
describe('R4 benchmark range is not a public target', () => {
  it('treats 198.18.0.0/15 as private', () => {
    for (const address of ['198.18.0.1', '198.18.0.32', '198.19.255.254']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('refuses a host that resolves into the benchmark range', async () => {
    await expect(
      fetchPage('https://example.com/', {
        lookup: async () => [{ address: '198.18.0.32', family: 4 }],
        fetchImpl: async () => fakeResponse('<html><body>x</body></html>'),
      }),
    ).rejects.toThrow(/BLOCKED_HOST/);
  });
});

describe('R5 text extraction', () => {
  it('keeps block structure and decodes entities', () => {
    const text = htmlToText('<p>一</p><p>二</p>&#65;&#x42;');
    expect(text.split('\n').filter((line) => line !== '')).toEqual(['一', '二', 'AB']);
  });

  it('returns an empty title when there is none', () => {
    expect(extractTitle('<html><body>x</body></html>')).toBe('');
  });
});
