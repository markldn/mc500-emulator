/** Probe remaining keys watching LED latch (port 0xC0 writes) and 0xF8 metronome. */
import { readFileSync } from 'fs';
import { MC500, CPU_HZ } from './js/mc500.js';

const rom = new Uint8Array(readFileSync(new URL('roms/MC-500-v2.2.bin', import.meta.url)));
const dsk = new Uint8Array(readFileSync(new URL('disks/MRC-500-v110.dsk', import.meta.url)));

function boot() {
    const mc = new MC500();
    mc.loadROM(rom); mc.insertDisk(dsk); mc.reset();
    mc.run(CPU_HZ * 4.5);
    return mc;
}
function tap(mc, p, b, hold = 0.25, settle = 0.4) {
    mc.keys.press(p, b); mc.run(CPU_HZ * hold);
    mc.keys.release(p, b); mc.run(CPU_HZ * settle);
}

const cands = [[1,2],[1,3],[1,4],[1,5],[1,6],[1,7],[2,0],[2,1],[2,2],[2,3],[2,4],[2,5],[3,1],[3,2],[3,3],[3,4],[3,6]];

for (const [p, b] of cands) {
    const mc = boot();
    const c0seen = new Set(), f8seen = new Set();
    const origWrite = mc.ioWrite.bind(mc);
    mc.ioWrite = (port, v) => {
        const lp = port & 0xFF;
        if (lp === 0xC0) c0seen.add(v);
        if (lp === 0xF8) f8seen.add(v);
        origWrite(port, v);
    };
    mc.cpu.bus.ioWrite = (port, v) => mc.ioWrite(port, v);
    tap(mc, p, b);
    mc.run(CPU_HZ * 3.0);
    const l = mc.lcd.getLines();
    console.log(`key ${p}:${b} c0={${[...c0seen].map(x=>x.toString(16)).join(',')}} f8={${[...f8seen].map(x=>x.toString(16)).join(',')}} |${l[0]}|/|${l[1]}|`);
}
