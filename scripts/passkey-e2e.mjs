// Passkey end-to-end check in real Chromium with a CDP virtual authenticator.
// Needs: npm i -D playwright (or a global install) and a running server. Usage: node scripts/passkey-e2e.mjs http://localhost:3000
// Set CHROMIUM_PATH if Playwright's bundled browser is not installed.
import { chromium } from 'playwright';
const BASE = process.argv[2] || 'http://localhost:3000';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ locale: 'ru-RU' });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
const email = `pk${Date.now()}@example.com`;
await page.goto(BASE + '/login');
await page.fill('#reg-email', email);
await page.click('#pk-register button[type=submit]');
await page.waitForURL('**/app/mode', { timeout: 15000 });
console.log('registered →', page.url());
// logout and sign in again with the passkey only
await page.click('footer .linkbtn');
await page.waitForURL(BASE + '/');
await page.goto(BASE + '/login');
await page.click('#pk-login');
await page.waitForURL('**/app', { timeout: 15000 });
console.log('passkey login →', page.url(), (await page.textContent('main')).includes(email));
// second registration with same email must be refused
await page.click('footer .linkbtn'); await page.waitForURL(BASE + '/');
await page.goto(BASE + '/login');
await page.fill('#reg-email', email);
await page.click('#pk-register button[type=submit]');
await page.waitForTimeout(1500);
console.log('duplicate email status:', await page.textContent('#pk-register-status'));
await browser.close();
