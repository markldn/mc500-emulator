/** Puppeteer smoke test: boot, LCD, buttons, dial, LEDs, themes. */
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('PAGE ERROR:', m.text()); });
page.on('pageerror', e => console.log('PAGE EXCEPTION:', e.message));

const BASE = process.env.MC500_URL || 'http://localhost:8500';
await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle0' });
await page.setViewport({ width: 1500, height: 1000 });

const lcd = async () => page.evaluate(() => window.mc500.lcd.getLines().map(s => s.trimEnd()));

// wait for boot (up to 30s of emulated progress)
let booted = false;
for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    const l = await lcd();
    if (l[0].startsWith('SONG')) { booted = true; console.log(`booted after ~${(i + 1) / 2}s:`, l); break; }
}
if (!booted) { console.log('BOOT FAILED:', await lcd()); await browser.close(); process.exit(1); }

// theme should default to mk1
console.log('mk1 visible:', await page.evaluate(() => !document.getElementById('panel-mk1').hidden));

// click MODE button (visible mk1 panel) -> "MODE 1 MIDI RECORDER"
const click = async (key) => {
    const sel = `#panel-mk1 .panel-btn[data-key="${key}"]`;
    await page.evaluate((s) => {
        const btn = document.querySelector(s);
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }, sel);
    await new Promise(r => setTimeout(r, 350));
    await page.evaluate((s) => {
        const btn = document.querySelector(s);
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, sel);
    await new Promise(r => setTimeout(r, 400));
};

await click('mode');
console.log('after MODE:', await lcd());
await click('1');
await click('enter');
console.log('after 1,ENTER (back to recorder):', await lcd());

// dial: wheel up 5 clicks on the visible dial -> tempo 125
for (let i = 0; i < 5; i++) {
    await page.evaluate(() => {
        document.querySelector('#panel-mk1 .alpha-dial')
            .dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    });
    await new Promise(r => setTimeout(r, 150));
}
await new Promise(r => setTimeout(r, 1200));
console.log('after dial +5 (tempo 125?):', await lcd());

// AVAIL MEMO (hold): press and hold 1s
await page.evaluate(() => {
    document.querySelector('#panel-mk1 .panel-btn[data-key="avail"]')
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
});
await new Promise(r => setTimeout(r, 1000));
console.log('during AVAIL:', await lcd());
await page.evaluate(() => {
    document.querySelector('#panel-mk1 .panel-btn[data-key="avail"]')
        .dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});
await click('stop');

// REC flow -> REC led should flash (led-rec gets led-on sometimes)
await click('rec');
console.log('after REC:', await lcd());
let recLedSeen = false;
for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (await page.evaluate(() => document.querySelector('#panel-mk1 .led-rec').classList.contains('led-on'))) recLedSeen = true;
}
console.log('REC led flashed:', recLedSeen);
await click('stop');

// theme switch to mk2
await page.select('#theme-select', 'mk2');
await new Promise(r => setTimeout(r, 300));
console.log('mk2 visible:', await page.evaluate(() => !document.getElementById('panel-mk2').hidden));
console.log('mk2 lcd text:', await page.evaluate(() =>
    [...document.querySelectorAll('#panel-mk2 .lcd-line')].map(e => e.textContent.trimEnd())));

// disk UI: dirty indicator + download
await page.evaluate(() => window.mc500.fdc.onDiskWrite());   // simulate a firmware disk write
await new Promise(r => setTimeout(r, 200));
console.log('disk status after write:', await page.evaluate(() =>
    document.getElementById('disk-status').textContent));
const client = await page.createCDPSession();
await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp/mc500-dl' });
await page.click('#btn-disk-download');
await new Promise(r => setTimeout(r, 1500));
console.log('disk status after download:', await page.evaluate(() =>
    document.getElementById('disk-status').textContent));

await page.select('#theme-select', 'mk1');
await new Promise(r => setTimeout(r, 200));
await page.screenshot({ path: 'screenshot-mk1.png' });
await page.select('#theme-select', 'mk2');
await new Promise(r => setTimeout(r, 200));
await page.screenshot({ path: 'screenshot-mk2.png' });

await browser.close();
console.log('DONE');
