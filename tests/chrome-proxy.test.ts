import { describe, expect, it } from 'vitest';
import { proxyArguments } from '../src/launcher/chrome.js';

describe('headless browser proxy configuration', () => {
  it('preserves system defaults and offers an explicit direct or proxy route', () => {
    expect(proxyArguments()).toEqual([]);
    expect(proxyArguments('direct')).toEqual(['--no-proxy-server']);
    expect(proxyArguments('socks5://127.0.0.1:7897')).toEqual(['--proxy-server=socks5://127.0.0.1:7897']);
    expect(proxyArguments('http://proxy.example:8080/')).toEqual(['--proxy-server=http://proxy.example:8080']);
  });
  it.each(['file:///tmp/proxy', 'http://user:secret@proxy.example:8080', 'http://proxy.example/path', 'http://proxy.example/?token=x'])('rejects unsupported or credential-bearing input %s', (value) => {
    expect(() => proxyArguments(value)).toThrow();
  });
});
