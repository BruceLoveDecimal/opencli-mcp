// Log in to DreamFace with an email and password, so every other dreamface command (and the page itself) runs as that
// account. It drives the site's own login dialog rather than calling /dw-server/user/login, because the site runs a
// reCAPTCHA before that call and writes the session (userInfo + loginSecretKey) into localStorage itself afterwards;
// the adapter only fills the form and waits for the stored session.
//
// The reCAPTCHA is never solved here. When it asks for a check, the command waits up to `captcha_wait_sec` for a person
// to complete it in the same page (an embedded view the user can see), and fails with `captcha_required` otherwise.
import { AdapterError, defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { LOGIN_SECRET_KEY, ORIGIN_ARG, USER_INFO_KEY, headers, siteOrigin, storedSession } from './_shared.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sameAccount = (s, email) => Boolean(s?.email) && s.email.trim().toLowerCase() === email.trim().toLowerCase();
const DIALOG = '[role=dialog]';

/** Login dialog state, read from the page: open, captcha shown, error text under the form. */
const STATE_JS = `(() => {
  const dialog = [...document.querySelectorAll(${JSON.stringify(DIALOG)})].find((d) => d.querySelector('input[name=email], input[name=password]'));
  const box = document.getElementById('recaptcha-email-form');
  const challenge = [...document.querySelectorAll('iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"]')]
    .some((f) => { const r = f.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(f).visibility !== 'hidden'; });
  const error = dialog ? [...dialog.querySelectorAll('[class*=error i], [class*=status i], [class*=message i]')]
    .map((e) => e.innerText.trim()).filter(Boolean).join(' ').slice(0, 200) : '';
  const toast = [...document.querySelectorAll('[class*=toast i], [role=status], [role=alert]')]
    .map((e) => e.innerText.trim()).filter((t) => /登录失败|Login failed|密码错误|Wrong password|suspend|expired|停用|过期/i.test(t)).join(' ').slice(0, 200);
  return { dialog: Boolean(dialog), captcha: Boolean(box && !box.classList.contains('hidden')) || challenge, error: error || toast };
})()`;

function result(s, origin, loggedInNow) {
  return {
    account: s.email,
    user_id: s.userId,
    account_id: s.accountId,
    logged_in_now: loggedInNow,
    // For a caller that sends the site's API requests itself (e.g. an acceptance run's HTTP tests).
    headers: headers(s),
    origin,
  };
}

/** Close dialogs that are not the login one: the home page opens a promotion banner a moment after load, with a
 * mask that intercepts clicks. Its own close button first, Escape otherwise. */
async function dismissOverlays(tab) {
  const other = `${DIALOG}:not(:has(input[name=email], input[name=password]))`;
  for (let i = 0; i < 4; i++) {
    const open = await tab.evaluate(`Boolean(document.querySelector(${JSON.stringify(other)}))`);
    if (!open) return;
    const closed = await tab.act({ action: 'click', target: { selector: `${other} button[class*="close" i]` }, timeoutMs: 3000 }).then(() => true, () => false);
    if (!closed) await tab.act({ action: 'press', value: 'Escape' }).catch(() => {});
    await sleep(700);
  }
}

/** Open the login dialog from "登录/注册", closing the banner first; a click it intercepts is retried. */
async function openLoginDialog(tab) {
  for (let attempt = 1; ; attempt++) {
    await dismissOverlays(tab);
    if ((await tab.evaluate(STATE_JS)).dialog) return;
    try {
      await tab.act({ action: 'click', target: { text: '登录/注册' }, timeoutMs: 8_000 });
      await tab.expect({ selector: `${DIALOG} input[name=email]` }, { timeoutMs: 8_000 });
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
      await sleep(1000);
    }
  }
}

export default defineAdapter({
  description: 'Log in to DreamFace with an email and password, replacing another account logged in to this browser. Returns the account and the API headers of its session. A reCAPTCHA check has to be completed by a person in the same page. （登录 账号 鉴权）',
  access: 'write',
  // run by the application hosting the agent, with credentials the agent never sees: not listed in sites_search
  audience: 'host',
  domain: 'facemojiapp.com',
  args: [
    ORIGIN_ARG,
    { name: 'email', type: 'string', required: true, help: 'Account email' },
    { name: 'password', type: 'string', required: true, help: 'Account password' },
    { name: 'captcha_wait_sec', type: 'int', default: 0, min: 0, max: 600, help: 'How long to wait for a person to complete a reCAPTCHA check in the page; 0 fails with captcha_required at once' },
    { name: 'timeout_sec', type: 'int', default: 60, min: 10, max: 900, help: 'Overall time for the login, including captcha_wait_sec' },
  ],
  result: { kind: 'value', description: 'The logged-in account (the login role of site.json)', fields: { account: 'string', user_id: 'string', account_id: 'string', logged_in_now: 'boolean', headers: 'object' } },
  async run({ tab, args }) {
    const origin = siteOrigin(args);
    const email = String(args.email).trim();
    if (!email || !args.password) throw errors.argument('email and password are required');
    const deadline = Date.now() + args.timeout_sec * 1000;
    const stepTimeout = () => Math.max(1, Math.min(8000, deadline - Date.now()));
    await tab.goto(`${origin}/zh/home`, { waitUntil: 'load' });

    const current = await storedSession(tab);
    if (sameAccount(current, email)) return result(current, origin, false);
    if (current) {
      // Another account: drop its stored session locally (no logout call, which would end it on the server too).
      await tab.evaluate(`(() => { localStorage.removeItem(${JSON.stringify(USER_INFO_KEY)}); localStorage.removeItem(${JSON.stringify(LOGIN_SECRET_KEY)}); return true; })()`, { allowWrite: true });
      await tab.goto(`${origin}/zh/home`, { waitUntil: 'load' });
    }

    await sleep(2500); // the banner opens a moment after load
    await openLoginDialog(tab);
    await tab.act({ action: 'fill', target: { selector: `${DIALOG} input[name=email]` }, value: email });
    // The current form checks the email first. Retain the legacy combined-form path without another submit.
    const passwordReady = await tab.evaluate(`Boolean(document.querySelector('${DIALOG} input[name=password]'))`);
    if (!passwordReady) {
      await tab.act({ action: 'click', target: { selector: `${DIALOG} button[type=submit]:visible` }, timeoutMs: stepTimeout() });
      await tab.expect({ selector: `${DIALOG} input[name=password]` }, { timeoutMs: stepTimeout() });
    }
    await tab.act({ action: 'fill', target: { selector: `${DIALOG} input[name=password]` }, value: String(args.password), timeoutMs: stepTimeout() });
    await tab.act({ action: 'click', target: { selector: `${DIALOG} form button[type=submit]` } });

    let captchaSince = null;
    while (Date.now() < deadline) {
      await sleep(1000);
      const s = await storedSession(tab);
      if (sameAccount(s, email)) return result(s, origin, true);
      const state = await tab.evaluate(STATE_JS);
      if (state.error) throw errors.auth(`DreamFace login failed: ${state.error}`, 'Check the account email and password.');
      if (state.captcha) {
        captchaSince ??= Date.now();
        if (Date.now() - captchaSince >= args.captcha_wait_sec * 1000) {
          throw new AdapterError(
            'captcha_required',
            args.captcha_wait_sec ? `the reCAPTCHA check was not completed within ${args.captcha_wait_sec}s` : 'DreamFace asks for a reCAPTCHA check',
            'A person has to complete it in this page; run again with captcha_wait_sec in a browser they can see.',
          );
        }
      }
    }
    throw errors.upstream(`DreamFace login did not finish within ${args.timeout_sec}s`, 'The dialog may need another step; look at the page.');
  },
});
