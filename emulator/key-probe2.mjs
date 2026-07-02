/** Contextual key probe: tempo-entry commit (ENTER) and MIDI page value keys. */
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
function tap(mc, p, b, hold = 0.25, settle = 0.45) {
    mc.keys.press(p, b); mc.run(CPU_HZ * hold);
    mc.keys.release(p, b); mc.run(CPU_HZ * settle);
}

const unknown = [[1,2],[1,3],[1,4],[1,5],[1,6],[1,7],[2,0],[2,1],[2,2],[2,3],[2,4],[2,5],[3,1],[3,2],[3,3],[3,4],[3,5],[3,6]];

console.log('--- scenario A: type 9,0 into tempo then press key ---');
for (const [p, b] of unknown) {
    const mc = boot();
    tap(mc, 1, 1); // 9
    tap(mc, 0, 0); // 0
    tap(mc, p, b);
    mc.run(CPU_HZ * 1.5);
    const l = mc.lcd.getLines();
    console.log(`key ${p}:${b}  |${l[0]}|/|${l[1]}|`);
}

console.log('--- scenario B: open MIDI page then press key ---');
for (const [p, b] of unknown) {
    const mc = boot();
    tap(mc, 3, 0); // MIDI
    tap(mc, p, b);
    const l = mc.lcd.getLines();
    console.log(`key ${p}:${b}  |${l[0]}|/|${l[1]}|`);
}
