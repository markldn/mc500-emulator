/** Probe the key matrix: press each (port,bit), log LCD reaction. */
import { readFileSync } from 'fs';
import { MC500, CPU_HZ } from './js/mc500.js';

const rom = new Uint8Array(readFileSync(new URL('roms/MC-500-v2.2.bin', import.meta.url)));
const dsk = new Uint8Array(readFileSync(new URL('disks/MRC-500-v110.dsk', import.meta.url)));

function bootMachine() {
    const mc = new MC500();
    mc.loadROM(rom);
    mc.insertDisk(dsk);
    mc.reset();
    mc.run(CPU_HZ * 4.5);
    return mc;
}

for (let p = 0; p < 4; p++) {
    for (let b = 0; b < 8; b++) {
        const mc = bootMachine();
        mc.keys.press(p, b);
        mc.run(CPU_HZ * 0.3);
        mc.keys.release(p, b);
        mc.run(CPU_HZ * 0.6);
        const l1 = mc.lcd.getLines();
        mc.run(CPU_HZ * 2.2);
        const l2 = mc.lcd.getLines();
        console.log(`key ${p}:${b}  |${l1[0]}|/|${l1[1]}|   later: |${l2[0]}|/|${l2[1]}|`);
    }
}
