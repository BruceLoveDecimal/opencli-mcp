/**
 * CdpBridge — the runtime's browser bridge over a CDP endpoint instead of the extension. The extension's page engine
 * runs in this process (extension/dist/cdp-backend.js, built from extension/src/node/backend.ts) and answers the same
 * commands the extension would, so every tool and the `js` object model work unchanged.
 *
 * Use it for browsers the agent should own rather than the user's Chrome: a headless Chrome started for a test run,
 * or an app's embedded view exposed through a single-page CDP relay.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROTOCOL_REVISION, type Action, type BrowserEvent, type BrowserFeature, type Command, type Result } from '../protocol.js';
import { BrowserCommandError, type BridgeEvents, type BrowserBridge } from './bridge.js';
import { extensionDir } from './registration.js';

interface CdpBackend {
  mode: 'browser' | 'page';
  features: BrowserFeature[];
  handle(cmd: Command): Promise<Result>;
  close(): Promise<void>;
}
interface CdpBackendModule {
  startCdpBackend(opts: { endpoint: string; pageModule: string; allowedOrigins?: string[]; onEvent?: (event: BrowserEvent) => void; onClose?: (reason: string) => void }): Promise<CdpBackend>;
}

export interface CdpBridgeOptions {
  endpoint: string;
  /** Origins pages may navigate to (enforced in the browser); empty allows every http(s) origin. */
  allowedOrigins?: string[];
}

export class CdpBridge extends EventEmitter<BridgeEvents> implements BrowserBridge {
  connected = false;
  readonly extensionVersion = 'cdp';
  readonly protocolRevision = PROTOCOL_REVISION;
  extensionFeatures: BrowserFeature[] = [];
  mode: 'browser' | 'page' | null = null;
  private backend: CdpBackend | null = null;

  get compatible(): boolean { return this.connected; }

  static async connect(opts: CdpBridgeOptions): Promise<CdpBridge> {
    const dir = extensionDir();
    const mod = await import(pathToFileURL(path.join(dir, 'cdp-backend.js')).href) as CdpBackendModule;
    const bridge = new CdpBridge();
    bridge.backend = await mod.startCdpBackend({
      endpoint: opts.endpoint,
      pageModule: fs.readFileSync(path.join(dir, 'page.js'), 'utf8'),
      allowedOrigins: opts.allowedOrigins,
      onEvent: (event) => bridge.emit('event', event),
      onClose: () => { bridge.connected = false; bridge.extensionFeatures = []; bridge.emit('close'); },
    });
    bridge.connected = true;
    bridge.mode = bridge.backend.mode;
    bridge.extensionFeatures = bridge.backend.features;
    bridge.emit('hello', { extensionVersion: bridge.extensionVersion, protocolRevision: PROTOCOL_REVISION, features: bridge.extensionFeatures });
    return bridge;
  }

  async send(action: Action, params: Omit<Command, 'id' | 'action'> = {}, opts: { timeoutMs?: number } = {}): Promise<{ data: unknown; page?: string }> {
    if (!this.backend || !this.connected) throw new BrowserCommandError('the CDP endpoint is disconnected', 'extension_disconnected');
    const timeoutMs = opts.timeoutMs ?? (params.timeoutMs ?? 60_000) + 5_000;
    const command: Command = { id: randomUUID(), action, ...params, deadlineAt: Date.now() + timeoutMs };
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      this.backend.handle(command),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BrowserCommandError(`${action} timed out after ${Math.round(timeoutMs / 1000)}s`, 'timeout')), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    if (!result.ok) throw new BrowserCommandError(result.error ?? `${action} failed`, result.errorCode ?? 'browser_command_failed', result.errorHint, result.data);
    return { data: result.data, page: result.page };
  }

  async close(): Promise<void> { await this.backend?.close(); }
}
