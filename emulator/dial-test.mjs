/** Final dial accuracy test with corrected parsing. */
import { readFileSync } from 'fs';
import { MC500, CPU_HZ } from './js/mc500.js';

const rom = new Uint8Array(readFileSync(new URL('roms/MC-500-v2.2.bin', import.meta.url)));
const dsk = new Uint8Array(readFileSync(new URL('disks/MRC-500-v110.dsk', import.meta.url)));

const mc = new MC500();
mc.loadROM(rom); mc.insertDisk(dsk); mc.reset();
mc.run(CPU_HZ * 4.5);

function tempo() {
    for (let i = 0; i < 12; i++) {
        mc.run(CPU_HZ * 0.09);
        const t = mc.lcd.getLines()[1].slice(10, 13).trim();
        if (t && /^\d+$/.test(t)) return parseInt(t, 10);
    }
    return NaN;
}

let expect = 120;
console.log('start:', tempo());
for (const d of [1, -1, 2, -2, 5, -8, 20, 50, -30]) {
    mc.dial(d);
    mc.run(CPU_HZ * (0.05 + Math.abs(d) * 0.02));
    expect = Math.min(250, Math.max(10, expect + d));
    const t = tempo();
    console.log(`dial(${String(d).padStart(3)}) -> ${t}  (expect ${expect})  ${t === expect ? 'OK' : 'MISS'}`);
}
