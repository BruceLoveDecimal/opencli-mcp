/**
 * `opencli-mcp cdp --endpoint <url>` — a stdio MCP server whose browser is a CDP endpoint (no extension, no Native
 * Messaging host). One process serves one MCP client and one browser; the runtime, tools and object model are the same
 * as with the extension. `--launch` starts a headless Chrome of its own instead, which ends with the process.
 */
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Runtime } from '../runtime/runtime.js';
import { createMcpServer } from '../mcp/server.js';
import { CdpBridge } from '../host/cdp-bridge.js';
import { readConfig } from '../host/state.js';
import { findChrome, launchHeadlessChrome, type LaunchedChrome } from './chrome.js';

export interface CdpOptions {
  version: string;
  /** CDP endpoint to drive; without it, `launch` must be set. */
  endpoint?: string;
  /** Start a headless Chrome (this path, or found with findChrome) and drive it. */
  launch?: { chrome?: string };
  allowedOrigins?: string[];
}

export async function runCdp(opts: CdpOptions): Promise<void> {
  const log = (m: string): void => { process.stderr.write(`[opencli-mcp cdp] ${m}\n`); };
  // stdout carries MCP frames: route stray console output to stderr
  console.log = (...args: unknown[]) => log(args.map(String).join(' '));
  console.info = console.log;
  console.warn = (...args: unknown[]) => log(args.map(String).join(' '));

  let chrome: LaunchedChrome | undefined;
  let endpoint = opts.endpoint;
  if (!endpoint) {
    const binary = opts.launch?.chrome ?? findChrome();
    if (!binary) throw new Error('no Chrome found: pass --chrome <path> or set CHROME_PATH');
    chrome = await launchHeadlessChrome(binary);
    endpoint = chrome.endpoint;
    log(`launched headless Chrome ${binary}`);
  }
  let bridge: CdpBridge;
  try {
    bridge = await CdpBridge.connect({ endpoint, allowedOrigins: opts.allowedOrigins });
  } catch (err) {
    await chrome?.close();
    throw err;
  }
  log(`connected to ${bridge.mode} endpoint`);
  const config = readConfig();
  const rt = new Runtime({ bridge, cursor: false, sites: config.sites, sitesWrite: config.sitesWrite, log });
  await rt.init();
  const session = createMcpServer(rt, randomUUID(), { version: opts.version, persistent: true });

  let closing = false;
  const shutdown = async (reason: string, code = 0): Promise<void> => {
    if (closing) return; closing = true;
    log(`shutting down (${reason})`);
    await session.close().catch(() => {});
    await bridge.close().catch(() => {});
    await chrome?.close().catch(() => {});
    process.exit(code);
  };
  bridge.on('close', () => void shutdown('the CDP endpoint closed', 1));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.stdin.on('end', () => void shutdown('stdin closed'));

  const transport = new StdioServerTransport();
  transport.onclose = () => void shutdown('client disconnected');
  await session.server.connect(transport);
}
