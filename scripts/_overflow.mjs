import { chromium } from '@playwright/test';
const b = await chromium.launch({ channel: 'chrome' });
async function run(email, paths) {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await p.goto('http://localhost:3100/login'); await p.fill('#email', email); await p.fill('#password', 'demo1234');
  await Promise.all([p.waitForURL(u => !u.pathname.startsWith('/login')), p.click('button[type=submit]')]);
  for (const path of paths) {
    await p.goto('http://localhost:3100' + path, { waitUntil: 'networkidle' }); await p.waitForTimeout(500);
    const r = await p.evaluate(() => {
      const W = window.innerWidth; const out = [`sw=${document.documentElement.scrollWidth} bodySW=${document.body.scrollWidth}`];
      for (const el of document.querySelectorAll('body *')) {
        const rc = el.getBoundingClientRect(); if (rc.right <= W + 2 || rc.width === 0) continue;
        const par = el.parentElement; const pr = par.getBoundingClientRect();
        if (pr.right <= W + 2) out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} right=${Math.round(rc.right)} pos=${getComputedStyle(el).position} parentOverflow=${getComputedStyle(par).overflowX} "${(el.textContent || '').trim().slice(0, 25)}"`);
      }
      return out.slice(0, 6);
    });
    console.log(path, '\n  ' + r.join('\n  '));
  }
}
await run('owner@veyro.demo', ['/finance/payroll', '/finance/rates', '/documents', '/time/manual']);
await run('recruiter@veyro.demo', ['/recruiting/candidates']);
await b.close();
