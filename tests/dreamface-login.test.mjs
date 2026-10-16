import { describe, expect, it } from 'vitest';
import login from '../adapters/dreamface/login.js';

// The form refuses password entry before its asynchronous email step, mirroring the released UI.
function form(twoStep) {
  let stage = 'email';
  let signedIn = false;
  let submits = 0;
  return {
    get submits() { return submits; },
    async goto() {},
    async evaluate(source) {
      if (source.includes('localStorage.getItem')) return signedIn ? { user: JSON.stringify({ token: 'private', userId: 'u', accountId: 'a', thirdId: 'test@example.com' }), clientId: 'client' } : { user: null };
      if (source.includes('const dialog')) return { dialog: true, captcha: false, error: '' };
      if (source.includes(':not(:has')) return false;
      if (source.includes('input[name=password]')) return !twoStep || stage === 'password';
      throw new Error('Unexpected read');
    },
    async act(args) {
      if (args.action === 'fill' && args.target.selector.includes('password') && twoStep && stage !== 'password') throw new Error('Password is not mounted');
      if (args.action === 'click' && args.target.selector.includes('submit')) {
        submits++;
        if (twoStep && stage === 'email') stage = 'password';
        else signedIn = true;
      }
    },
    async expect() { if (twoStep && stage !== 'password') throw new Error('No password screen'); },
  };
}
describe('DreamFace host login forms', () => {
  for (const twoStep of [true, false]) it(`authenticates ${twoStep ? 'two-step' : 'combined'} forms without replaying login`, async () => {
    const tab = form(twoStep);
    const value = await login.run({ tab, args: { origin: 'https://testm.facemojiapp.com', email: 'test@example.com', password: 'secret', captcha_wait_sec: 0, timeout_sec: 10 } });
    expect(value.logged_in_now).toBe(true);
    expect(tab.submits).toBe(twoStep ? 2 : 1);
  });
});
