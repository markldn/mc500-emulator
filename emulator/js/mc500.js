/**
 * Roland MC-500 MicroComposer machine model.
 *
 * Physical memory map (20-bit):
 *   0x00000-0x01FFF  8KB boot ROM
 *   0x40000-0x7FFFF  256KB DRAM
 *   elsewhere        open bus (reads 0xFF)
 *
 * External I/O (low byte of port address):
 *   0x80       gate array control (W) / status (R)
 *   0xA0/0xA1  LCD (HD44780-compatible, 2 x 20)
 *   0xB0       gate array status: bit3=disk absent, bit2=write protect
 *   0xC0       key matrix column select (W), switch rows (R at 0xC0-0xC3)
 *   0xE0-0xE3  WD1772 FDC
 *   0xF8       control latch (drive side select, motor, metronome)
 */

import { Z180 } from './z180.js';
import { WD1772 } from './wd1772.js';

export const CPU_HZ = 6144000;

// Alpha dial timing (cycles): OS debounce ~10ms, one count per ~16.7ms held.
// Release gap of 2 sample periods so the OS debounce fully resets between
// windows (a shorter gap merges windows and double-counts the debounce time).
const DIAL_DEBOUNCE = Math.round(CPU_HZ * 0.010);
const DIAL_STEP = Math.round(CPU_HZ * 0.0167);
const DIAL_GAP = Math.round(CPU_HZ * 0.035);

// ---------------- HD44780 LCD ----------------
class LCD {
    constructor() { this.reset(); }
    reset() {
        this.ddram = new Uint8Array(128).fill(0x20);
        this.cgram = new Uint8Array(64);
        this.addr = 0;
        this.cgMode = false;
        this.increment = true;
        this.displayOn = false;
        this.shift = 0;            // display window offset (0-39)
        this.dirty = true;
    }
    command(v) {
        if (v & 0x80) { this.addr = v & 0x7F; this.cgMode = false; }
        else if (v & 0x40) { this.addr = v & 0x3F; this.cgMode = true; }
        else if (v & 0x20) { /* function set */ }
        else if (v & 0x10) {
            // Cursor/display shift. S/C (bit3)=1 shifts the display window;
            // R/L (bit2)=1 shifts right (window offset decrements, mod 40).
            if (v & 0x08) this.shift = (this.shift + ((v & 0x04) ? 39 : 1)) % 40;
        }
        else if (v & 0x08) { this.displayOn = !!(v & 0x04); }
        else if (v & 0x04) { this.increment = !!(v & 0x02); }
        else if (v & 0x02) { this.addr = 0; this.cgMode = false; this.shift = 0; }
        else if (v & 0x01) { this.ddram.fill(0x20); this.addr = 0; this.cgMode = false; this.shift = 0; }
        this.dirty = true;
    }
    data(v) {
        if (this.cgMode) this.cgram[this.addr & 0x3F] = v;
        else this.ddram[this.addr & 0x7F] = v;
        this.addr = (this.addr + (this.increment ? 1 : -1)) & 0x7F;
        this.dirty = true;
    }
    readStatus() { return this.addr & 0x7F; } // busy always 0
    readData() {
        const v = this.cgMode ? this.cgram[this.addr & 0x3F] : this.ddram[this.addr & 0x7F];
        this.addr = (this.addr + (this.increment ? 1 : -1)) & 0x7F;
        return v;
    }
    /**
     * Two 20-char lines. DDRAM: line1 = 0x00-0x27, line2 = 0x40-0x67 (40 chars
     * each); the visible 20-char window starts at the display shift offset.
     */
    getLines() {
        const render = (base) => {
            let s = '';
            for (let i = 0; i < 20; i++) {
                const c = this.ddram[base + (this.shift + i) % 40];
                s += (c >= 0x20 && c < 0x7F) ? String.fromCharCode(c) : (c < 8 ? '█' : '?');
            }
            return s;
        };
        return [render(0x00), render(0x40)];
    }
}

// ---------------- Key matrix ----------------
/**
 * Panel switches are read at ports 0xC0-0xC3; idle (nothing pressed) is
 * 0xFF on all ports. Holding the service combo at power-on makes the ROM
 * read FF FF F7 FB and branch into the factory test program instead of
 * the normal boot path. A pressed key pulls its bit low. Key positions
 * are addressed as "port:bit" (port 0-3).
 */
class Keys {
    constructor() {
        this.idle = [0xFF, 0xFF, 0xFF, 0xFF];
        this.pressed = new Set(); // "p:b"
    }
    press(p, b) { this.pressed.add(p + ':' + b); }
    release(p, b) { this.pressed.delete(p + ':' + b); }
    releaseAll() { this.pressed.clear(); }
    read(p) {
        let v = this.idle[p];
        for (const k of this.pressed) {
            const [kp, kb] = k.split(':').map(Number);
            if (kp === p) v &= ~(1 << kb);
        }
        return v;
    }
}

// ---------------- Machine ----------------
export class MC500 {
    constructor() {
        this.rom = new Uint8Array(0x2000);
        this.ram = new Uint8Array(0x40000);
        this.lcd = new LCD();
        this.keys = new Keys();
        this.fdc = new WD1772();

        this.ctrl80 = 0;
        this.ctrlF8 = 0;
        this.leds = 0xFF;             // panel LED latch (active low)

        this.ioLog = new Map();     // "dir:port" -> count (unknown ports)
        this.trace = null;

        // MIDI: ASCI0 = MIDI IN + OUT1, ASCI1 = OUT2
        this.midiRxQueue = [];
        this.midiRxNext = 0;          // earliest tstate for next RX byte
        this.onMidiOut = null;        // callback(channel, byte)

        // Alpha dial: direction lines on port 0xB0 bits 7 (up) / 6 (down).
        // The OS counts one step per ~16.7ms that a line stays asserted,
        // after a ~10ms debounce: counts = round((T - 10ms) / 16.7ms).
        // So N queued steps become one assert window of 10ms + N*16.7ms.
        this.dialPending = 0;         // signed step count
        this.dialActive = 0;          // 0x80, 0x40 or 0
        this.dialPhase = 0;           // cycles left in current window (hold or gap)

        const bus = {
            physRead: (a) => this.physRead(a),
            physWrite: (a, v) => this.physWrite(a, v),
            ioRead: (p) => this.ioRead(p),
            ioWrite: (p, v) => this.ioWrite(p, v),
            midiOut: (ch, byte) => { if (this.onMidiOut) this.onMidiOut(ch, byte); },
        };
        this.cpu = new Z180(bus);

        // FDC INTRQ is wired to /INT1; the disk-change line from the gate
        // array is /INT2 (acknowledged by reading port 0x80).
        this.fdc.onIntr = (level) => { this.cpu.int1Line = level; };
    }

    loadROM(data) { this.rom.set(data.subarray(0, 0x2000)); }
    insertDisk(data, wp = false) { this.fdc.insertDisk(data, wp); }

    reset() {
        this.cpu.reset();
        this.cpu.pc = 0;
        this.lcd.reset();
        this.ctrl80 = 0; this.ctrlF8 = 0;
        // RAM deliberately left as-is (battery backed on real hardware)
    }

    physRead(a) {
        if (a < 0x2000) return this.rom[a];
        if (a >= 0x40000 && a < 0x80000) return this.ram[a - 0x40000];
        return 0xFF;
    }
    physWrite(a, v) {
        if (a >= 0x40000 && a < 0x80000) this.ram[a - 0x40000] = v;
    }

    ioRead(port) {
        const p = port & 0xFF;
        switch (p) {
            case 0x80:
                this.cpu.int2Line = false;                // ack disk-change IRQ
                return 0x00;                              // gate array status
            case 0xA0: return this.lcd.readStatus();
            case 0xA1: return this.lcd.readData();
            case 0xB0: {
                // bit3: no disk; bit2: reads 1 on real hardware — the driver
                // uses it to select the plain-seek positioning path (the
                // alternate path in ROM is dead code with an HL clobber).
                // bits 6/7: alpha dial down/up pulse lines.
                let v = 0x04 | this.dialActive;
                if (!this.fdc.diskInserted) v |= 0x08;
                return v;
            }
            case 0xC0: return this.keys.read(0);
            case 0xC1: return this.keys.read(1);
            case 0xC2: return this.keys.read(2);
            case 0xC3: return this.keys.read(3);
            case 0xE0: case 0xE1: case 0xE2: case 0xE3:
                return this.fdc.readReg(p & 3);
            default:
                this.logIO('R', p);
                return 0xFF;
        }
    }

    ioWrite(port, v) {
        const p = port & 0xFF;
        switch (p) {
            case 0x80:
                // Gate array drive control: bit5 = side select, bit4 = motor
                this.ctrl80 = v;
                this.fdc.setSide((v >> 5) & 1);
                break;
            case 0xA0: this.lcd.command(v); break;
            case 0xA1: this.lcd.data(v); break;
            case 0xC0:
                // Panel LED latch, active low: bit0 REC, bit1 PLAY, bit2 PAUSE,
                // bits 3-6 TRACK1-4, bit7 RHYTHM.
                this.leds = v;
                break;
            case 0xE0: case 0xE1: case 0xE2: case 0xE3:
                this.fdc.writeReg(p & 3, v);
                break;
            case 0xF8:
                this.ctrlF8 = v;   // metronome/beeper latch
                break;
            default:
                this.logIO('W', p);
        }
    }

    logIO(dir, p) {
        const k = dir + ':' + p.toString(16).padStart(2, '0');
        this.ioLog.set(k, (this.ioLog.get(k) || 0) + 1);
    }

    /** Queue incoming MIDI bytes (delivered to ASCI0 at wire speed). */
    midiIn(bytes) {
        for (const b of bytes) this.midiRxQueue.push(b & 0xFF);
    }

    /** Turn the alpha dial by `delta` detents (positive = clockwise/up). */
    dial(delta) {
        delta |= 0;
        if (delta === 0) return;
        const bit = delta > 0 ? 0x80 : 0x40;
        if (this.dialActive === bit && this.dialPhase > 0) {
            // extend the active window rather than queueing a new one
            this.dialPhase += Math.abs(delta) * DIAL_STEP;
        } else {
            this.dialPending += delta;
        }
    }

    /** Run for approximately `cycles` T-states. */
    run(cycles) {
        const cpu = this.cpu;
        const end = cpu.tstates + cycles;
        while (cpu.tstates < end) {
            if (this.trace) this.trace(cpu);
            const used = cpu.step();
            this.fdc.tick(used);
            // Alpha dial window management (see constructor comment).
            if (this.dialPhase > 0) {
                this.dialPhase -= used;
                if (this.dialPhase <= 0) {
                    // hold window done -> insert a debounce-reset gap
                    if (this.dialActive) { this.dialActive = 0; this.dialPhase = DIAL_GAP; }
                }
            } else if (this.dialPending !== 0) {
                const n = Math.abs(this.dialPending);
                this.dialActive = this.dialPending > 0 ? 0x80 : 0x40;
                this.dialPending = 0;
                this.dialPhase = DIAL_DEBOUNCE + n * DIAL_STEP;
            }
            // Service FDC DRQ through DMA channel 1
            if (this.fdc.drq) {
                let guard = 8;
                while (this.fdc.drq && guard-- > 0 && cpu.dreq1()) { /* burst */ }
            }
            // Deliver queued MIDI input at 31250 baud
            if (this.midiRxQueue.length && !(cpu.asci.stat0 & 0x80) &&
                cpu.tstates >= this.midiRxNext) {
                cpu.asci.rdr0 = this.midiRxQueue.shift();
                cpu.asci.stat0 |= 0x80;   // RDRF
                this.midiRxNext = cpu.tstates + 1966;
            }
        }
    }
}
