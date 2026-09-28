/**
 * A headless Chrome owned by one `opencli-mcp cdp --launch` process: throwaway profile, debugging port bound to
 * 127.0.0.1, killed and removed with the process. For agents that need a browser of their own when no app offers one.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const START_TIMEOUT_MS = 20_000;

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** CHROME_PATH, else a Chrome or Chromium at a usual location. */
export function findChrome(): string | undefined {
  return [process.env.CHROME_PATH, ...CANDIDATES].find((p): p is string => Boolean(p) && fs.existsSync(p!));
}

export interface LaunchedChrome { endpoint: string; close(): Promise<void> }

export async function launchHeadlessChrome(chrome: string): Promise<LaunchedChrome> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-mcp-chrome-'));
  const proc = spawn(chrome, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', 'about:blank',
  ], { stdio: 'ignore' });
  let exited = false;
  const gone = new Promise<void>((resolve) => proc.once('exit', () => { exited = true; resolve(); }));
  proc.once('error', () => { exited = true; });
  const close = async (): Promise<void> => {
    if (!exited) {
      proc.kill('SIGTERM');
      const killed = setTimeout(() => proc.kill('SIGKILL'), 5000);
      await gone;
      clearTimeout(killed);
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  };
  const portFile = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline && !exited) {
    const lines = fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8').split('\n') : [];
    if (lines[0]) return { endpoint: `http://127.0.0.1:${lines[0]}`, close };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await close();
  throw new Error(`headless Chrome did not start: ${chrome}`);
}
