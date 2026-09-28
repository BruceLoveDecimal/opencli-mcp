import { describe, expect, it } from 'vitest';
import { recordingSteps, replaySteps } from '../src/codegen/recording.js';
import { renderScript } from '../src/codegen/playwright.js';
import type { RecordEvent } from '../src/protocol.js';
import type { RecordedAction } from '../src/shared/page-contract.js';

let seq = 0;
const loc = (js: string, py: string) => ({ javascript: js, python: py });
const EMAIL = { selector: 'internal:label="Email"i', locator: loc(`getByLabel('Email')`, `get_by_label("Email")`) };
const PW = { selector: 'internal:label="Password"i', locator: loc(`getByLabel('Password')`, `get_by_label("Password")`) };
const LOGIN = { selector: 'internal:role=button[name="Log in"i]', locator: loc(`getByRole('button', { name: 'Log in' })`, `get_by_role("button", name="Log in")`) };
function action(ts: number, a: Partial<RecordedAction> & Pick<RecordedAction, 'name' | 'selector' | 'locator'>, page = 'P'): RecordEvent {
  return { seq: ++seq, tabId: 1, page, ts, type: 'action', action: { ts, ...a } };
}
const nav = (ts: number, url: string, page = 'P'): RecordEvent => ({ seq: ++seq, tabId: 1, page, ts, type: 'navigation', url });

describe('recording → steps', () => {
  it('collapses keystrokes, keeps secrets out, and treats the click’s navigation as its effect', () => {
    const events: RecordEvent[] = [
      action(1000, { name: 'click', ...EMAIL, clickCount: 1 }),
      action(1100, { name: 'fill', ...EMAIL, text: 'a' }),
      action(1200, { name: 'fill', ...EMAIL, text: 'ab' }),
      action(1300, { name: 'fill', ...EMAIL, text: 'ab@x.io' }),
      action(1400, { name: 'fill', ...PW, text: '', secret: true }),
      action(1500, { name: 'fill', ...PW, text: '', secret: true }),
      action(1600, { name: 'press', ...PW, key: 'Enter', modifiers: 0 }),
      nav(2000, 'https://app.example/home'),
      nav(9000, 'https://app.example/typed'), // later than the signal window: the person typed it
      nav(9100, 'https://app.example/typed/final'), // redirect: keeps the final URL
    ];
    const steps = recordingSteps(events, { page: 'P', url: 'https://app.example/login' });
    expect(renderScript(steps, 'javascript', { title: 'login' })).toBe([
      `import { test, expect } from '@playwright/test';`,
      '',
      `test('login', async ({ page, context }) => {`,
      `  await page.goto('https://app.example/login');`,
      `  await page.getByLabel('Email').click();`,
      `  await page.getByLabel('Email').fill('ab@x.io');`,
      `  await page.getByLabel('Password').fill(process.env.SECRET_1 ?? '');`,
      `  await page.getByLabel('Password').press('Enter');`,
      `  await page.goto('https://app.example/typed/final');`,
      '});',
      '',
    ].join('\n'));
    expect(replaySteps(steps)).toEqual([
      { tab: 'P', action: 'click', target: { selector: EMAIL.selector } },
      { tab: 'P', action: 'fill', target: { selector: EMAIL.selector }, value: 'ab@x.io' },
      { tab: 'P', action: 'fill', target: { selector: PW.selector }, secret: true },
      { tab: 'P', action: 'press', target: { selector: PW.selector }, value: 'Enter' },
      { tab: 'P', action: 'goto', url: 'https://app.example/typed/final' },
    ]);
  });

  it('merges a double click, and attaches popups, downloads and answered dialogs to their action', () => {
    const events: RecordEvent[] = [
      action(1000, { name: 'click', ...LOGIN, clickCount: 1 }),
      action(1100, { name: 'click', ...LOGIN, clickCount: 2 }),
      { seq: ++seq, tabId: 1, page: 'P', ts: 1200, type: 'dialog', dialogType: 'confirm', message: 'Sure?', accepted: true },
      { seq: ++seq, tabId: 1, page: 'P', ts: 1300, type: 'popup', childTabId: 2, childPage: 'C', url: 'https://sso.example/' },
      nav(1400, 'https://sso.example/authorize', 'C'), // the popup loading itself
      action(3000, { name: 'click', ...LOGIN, frame: [0] }, 'C'),
      { seq: ++seq, tabId: 2, page: 'C', ts: 3100, type: 'download', url: 'https://sso.example/x.pdf' },
      action(4000, { name: 'setInputFiles', ...EMAIL, files: ['a.png'], frame: null, frameUrl: 'https://pay.example/f' }, 'C'),
    ];
    const code = renderScript(recordingSteps(events, { page: 'P', url: 'https://app.example/' }), 'javascript');
    expect(code).toContain([
      `  page.once('dialog', dialog => dialog.accept().catch(() => {}));`,
      `  const page1Promise = page.waitForEvent('popup');`,
      `  await page.getByRole('button', { name: 'Log in' }).dblclick();`,
      `  const page1 = await page1Promise;`,
      `  const downloadPromise = page1.waitForEvent('download');`,
      `  await page1.locator('iframe, frame').nth(0).contentFrame().getByRole('button', { name: 'Log in' }).click();`,
      `  const download = await downloadPromise;`,
      `  // the page only reports file names: replace them with paths on your machine`,
      `  await page1.locator('iframe[src*="pay.example/f"]').contentFrame().getByLabel('Email').setInputFiles(['a.png']);`,
    ].join('\n'));
    expect(code).not.toContain('sso.example/authorize');
    const replay = replaySteps(recordingSteps(events, { page: 'P' }));
    expect(replay[0]).toMatchObject({ action: 'dblclick' });
    expect(replay[1]).toEqual({ tab: 'C', action: 'click', target: { selector: LOGIN.selector, frame: [0] } });
    expect(replay[2]).toMatchObject({ action: 'upload', files: ['a.png'], note: 'not replayed exactly by tab_act: inside a frame with no known path (https://pay.example/f); pass its <iframe> as target.frame' });
  });
});
