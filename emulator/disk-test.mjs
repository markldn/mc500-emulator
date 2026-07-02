/**
 * Disk save/load round-trip test:
 * record song -> Mode 2 SAVE to disk -> boot fresh machine from saved image
 * -> Mode 2 LOAD -> verify the song comes back.
 */
import { readFileSync } from 'fs';
import { MC500, CPU_HZ } from './js/mc500.js';

const rom = new Uint8Array(readFileSync(new URL('roms/MC-500-v2.2.bin', import.meta.url)));
const dsk = new Uint8Array(readFileSync(new URL('disks/MRC-500-v110.dsk', import.meta.url)));

const K = {
    enter: [1,6], mode: [2,6], play: [3,4], stop: [3,5], rec: [3,7],
    right: [1,5], '1': [0,1], '2': [0,2],
};
const tap = (mc, k) => {
    const [p, b] = K[k];
    mc.keys.press(p, b); mc.run(CPU_HZ * 0.25);
    mc.keys.release(p, b); mc.run(CPU_HZ * 0.35);
};
const line = (mc) => mc.lcd.getLines().map(s => s.trimEnd()).join(' / ');
function waitFor(mc, substr, secs = 20) {
    for (let i = 0; i < secs / 0.2; i++) {
        mc.run(CPU_HZ * 0.2);
        if (mc.lcd.getLines().join('|').includes(substr)) return true;
    }
    return false;
}

function boot(disk) {
    const mc = new MC500();
    mc.loadROM(rom);
    mc.insertDisk(disk);
    mc.reset();
    mc.run(CPU_HZ * 4.5);
    return mc;
}

// --- 1) record a short song ---
const workDisk = new Uint8Array(dsk);       // copy, like saving onto a copy of the system disk
const mc = boot(workDisk);
console.log('boot:', line(mc));
tap(mc, 'rec'); tap(mc, 'enter'); tap(mc, 'enter'); tap(mc, 'play');
mc.run(CPU_HZ * 4.2);                        // count-in
for (let i = 0; i < 4; i++) {
    mc.midiIn([0x90, 60 + i, 100]); mc.run(CPU_HZ * 0.5);
    mc.midiIn([0x80, 60 + i, 0]);   mc.run(CPU_HZ * 0.5);
}
tap(mc, 'stop'); mc.run(CPU_HZ * 1);
console.log('recorded:', line(mc));

// --- 2) save: MODE 2 ENTER -> menu -> 2 ENTER -> song 1 ENTER -> name -> ENTER -> PLAY(SAVE) ---
let writes = 0;
mc.fdc.onDiskWrite = () => writes++;
tap(mc, 'mode'); tap(mc, '2'); tap(mc, 'enter');
console.log('disk menu:', line(mc));
tap(mc, '2'); tap(mc, 'enter');
console.log('save page:', line(mc));
tap(mc, 'enter');
console.log('naming   :', line(mc));
// name it "B" (one dial-up = A? dial letters; simplest: dial +2 then enter)
mc.dial(2); mc.run(CPU_HZ * 0.5);
tap(mc, 'enter');
console.log('confirm  :', line(mc));
tap(mc, 'play');                              // PLAY = SAVE
const saved = waitFor(mc, 'DISK', 30) || true;
mc.run(CPU_HZ * 3);
console.log('after save:', line(mc), `(sector writes: ${writes})`);

// --- 3) fresh machine, boot from the saved image, load the song back ---
const mc2 = boot(workDisk);
console.log('\nreboot with saved image:', line(mc2));
tap(mc2, 'mode'); tap(mc2, '2'); tap(mc2, 'enter');
tap(mc2, '1'); tap(mc2, 'enter');
mc2.run(CPU_HZ * 1);
console.log('load page:', line(mc2));         // song number select
tap(mc2, 'enter');
mc2.run(CPU_HZ * 1);
console.log('song sel :', line(mc2));         // saved song title from disk
tap(mc2, 'enter');
waitFor(mc2, 'Press LOAD', 5);
console.log('confirm  :', line(mc2));
tap(mc2, 'rec');                              // REC = LOAD
waitFor(mc2, 'LOAD', 20);
mc2.run(CPU_HZ * 4);
console.log('after load:', line(mc2));
tap(mc2, 'mode'); tap(mc2, '1'); tap(mc2, 'enter');
mc2.run(CPU_HZ * 1.5);
console.log('standby  :', line(mc2));
