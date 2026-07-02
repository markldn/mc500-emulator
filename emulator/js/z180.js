/**
 * Z180 (HD64180) CPU core for the Roland MC-500 emulator.
 *
 * Implements the full Z80 instruction set plus the Z180 additions
 * (IN0/OUT0, MLT, TST, TSTIO, SLP, OTIM/OTDM/OTIMR/OTDMR) and the
 * on-chip peripherals the MC-500 boot ROM and OS rely on:
 *   - MMU (CBAR/CBR/BBR, additive translation to 20-bit physical)
 *   - Two DMA channels (ch0 memory-memory, ch1 memory<->I/O)
 *   - Two programmable reload timers (PRT0/PRT1)
 *   - Free-running counter (FRC, I/O 0x18)
 *   - ASCI status stubs (STAT0 with DCD0 low, TDRE high)
 *   - Vectored internal interrupts + external INT0 (IM1), INT1, INT2
 *
 * The core talks to the outside world through four callbacks supplied
 * by the machine: physRead/physWrite (20-bit physical memory) and
 * ioRead/ioWrite (external I/O, called for ports outside the on-chip
 * register file).
 */

const FLAG_C = 0x01, FLAG_N = 0x02, FLAG_PV = 0x04, FLAG_X = 0x08;
const FLAG_H = 0x10, FLAG_Y = 0x20, FLAG_Z = 0x40, FLAG_S = 0x80;

// Precomputed S/Z/X/Y flag table and parity table
const SZ = new Uint8Array(256);
const SZP = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
    let p = i, bits = 0;
    while (p) { bits += p & 1; p >>= 1; }
    SZ[i] = (i & 0x80) | (i === 0 ? FLAG_Z : 0) | (i & (FLAG_X | FLAG_Y));
    SZP[i] = SZ[i] | ((bits & 1) === 0 ? FLAG_PV : 0);
}

export class Z180 {
    constructor(bus) {
        // bus: { physRead(addr20), physWrite(addr20, val), ioRead(port16), ioWrite(port16, val) }
        this.bus = bus;
        this.reset();
    }

    reset() {
        this.a = 0xFF; this.f = 0xFF;
        this.b = 0; this.c = 0; this.d = 0; this.e = 0;
        this.h = 0; this.l = 0;
        this.a_ = 0; this.f_ = 0; this.b_ = 0; this.c_ = 0;
        this.d_ = 0; this.e_ = 0; this.h_ = 0; this.l_ = 0;
        this.ix = 0; this.iy = 0;
        this.sp = 0xFFFF;
        this.pc = 0;
        this.i = 0; this.r = 0;
        this.iff1 = false; this.iff2 = false;
        this.im = 0;
        this.halted = false;
        this.pendingEI = false;

        this.tstates = 0;          // total cycle counter

        // --- On-chip registers ---
        // MMU
        this.cbar = 0xF0; this.cbr = 0; this.bbr = 0;
        // Interrupt control
        this.il = 0;               // interrupt vector low (IL, 0x33)
        this.itc = 0x01;           // ITC (0x34): ITE0 set at reset
        this.icr = 0x00;           // I/O control register (0x3F): internal I/O base
        // Refresh / wait / misc
        this.rcr = 0xC0; this.dcntl = 0xF0; this.omcr = 0xFF;
        // ASCI (stubs, enough for boot + MIDI out logging)
        this.asci = {
            cntla0: 0x10, cntla1: 0x10, cntlb0: 0x07, cntlb1: 0x07,
            stat0: 0x02, stat1: 0x02,   // TDRE=1, DCD0=0
            tdr0: 0, tdr1: 0, rdr0: 0, rdr1: 0,
            tx0: 0, tx1: 0,             // cycles until TDRE re-asserts
        };
        // One MIDI byte at 31250 baud (10 bit times) at 6.144MHz
        this.asciByteCycles = 1966;
        // CSI/O — the MC-500 driver uses continuous CSI/O transmission as a
        // ~600Hz periodic interrupt source (EIE + TE, EF interrupt).
        this.cntr = 0x07; this.trdr = 0;
        this.csioShift = 0;   // countdown in cycles while shifting
        // PRT timers
        this.tmdr0 = 0xFFFF; this.rldr0 = 0xFFFF;
        this.tmdr1 = 0xFFFF; this.rldr1 = 0xFFFF;
        this.tcr = 0x00;
        this.prtPrescale = 0;      // divide-by-20 prescaler
        this.tif0Latch = false;    // TCR/TMDR read sequence for clearing TIF
        this.tif1Latch = false;
        // FRC: derived from tstates
        // DMA
        this.sar0 = 0; this.dar0 = 0; this.bcr0 = 0;
        this.mar1 = 0; this.iar1 = 0; this.bcr1 = 0;
        this.dstat = 0x30; this.dmode = 0; // DWE bits set
        this.dmaIrq0 = false; this.dmaIrq1 = false;

        // External interrupt lines (level-sensitive)
        this.int0Line = false;
        this.int1Line = false;
        this.int2Line = false;
        this.nmiLine = false; this.nmiSeen = false;

        // Diagnostics
        this.onUndefined = null;   // callback(pc, bytes)
    }

    // ---------------- register pair helpers ----------------
    get bc() { return (this.b << 8) | this.c; }
    set bc(v) { this.b = (v >> 8) & 0xFF; this.c = v & 0xFF; }
    get de() { return (this.d << 8) | this.e; }
    set de(v) { this.d = (v >> 8) & 0xFF; this.e = v & 0xFF; }
    get hl() { return (this.h << 8) | this.l; }
    set hl(v) { this.h = (v >> 8) & 0xFF; this.l = v & 0xFF; }
    get af() { return (this.a << 8) | this.f; }
    set af(v) { this.a = (v >> 8) & 0xFF; this.f = v & 0xFF; }

    // ---------------- MMU ----------------
    translate(addr) {
        addr &= 0xFFFF;
        const ca1 = (this.cbar & 0xF0) << 8;   // CA1 start (logical)
        const ba = (this.cbar & 0x0F) << 12;   // Bank Area start (logical)
        if (addr >= ca1) return (addr + (this.cbr << 12)) & 0xFFFFF;
        if (addr >= ba) return (addr + (this.bbr << 12)) & 0xFFFFF;
        return addr;
    }

    read8(addr) { return this.bus.physRead(this.translate(addr)); }
    write8(addr, v) { this.bus.physWrite(this.translate(addr), v & 0xFF); }
    read16(addr) { return this.read8(addr) | (this.read8(addr + 1) << 8); }
    write16(addr, v) { this.write8(addr, v & 0xFF); this.write8(addr + 1, (v >> 8) & 0xFF); }

    fetch8() { const v = this.read8(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
    fetch16() { const v = this.read16(this.pc); this.pc = (this.pc + 2) & 0xFFFF; return v; }

    push16(v) {
        this.sp = (this.sp - 1) & 0xFFFF; this.write8(this.sp, (v >> 8) & 0xFF);
        this.sp = (this.sp - 1) & 0xFFFF; this.write8(this.sp, v & 0xFF);
    }
    pop16() {
        const lo = this.read8(this.sp); this.sp = (this.sp + 1) & 0xFFFF;
        const hi = this.read8(this.sp); this.sp = (this.sp + 1) & 0xFFFF;
        return lo | (hi << 8);
    }

    // ---------------- I/O dispatch ----------------
    ioIn(port) {
        port &= 0xFFFF;
        const p = port & 0xFF;
        const base = this.icr & 0xC0;
        if ((p & 0xC0) === base && (p & 0x3F) < 0x40) {
            return this.readInternal(p & 0x3F);
        }
        return this.bus.ioRead(port) & 0xFF;
    }
    ioOut(port, val) {
        port &= 0xFFFF; val &= 0xFF;
        const p = port & 0xFF;
        const base = this.icr & 0xC0;
        if ((p & 0xC0) === base && (p & 0x3F) < 0x40) {
            this.writeInternal(p & 0x3F, val);
            return;
        }
        this.bus.ioWrite(port, val);
    }

    readInternal(r) {
        switch (r) {
            case 0x00: return this.asci.cntla0;
            case 0x01: return this.asci.cntla1;
            case 0x02: return this.asci.cntlb0;
            case 0x03: return this.asci.cntlb1;
            case 0x04: return this.asci.stat0;   // TDRE=1, DCD0=0
            case 0x05: return this.asci.stat1;
            case 0x06: return this.asci.tdr0;
            case 0x07: return this.asci.tdr1;
            case 0x08: this.asci.stat0 &= 0x7F; return this.asci.rdr0;
            case 0x09: this.asci.stat1 &= 0x7F; return this.asci.rdr1;
            case 0x0A: { const v = this.cntr; this.cntr &= 0x7F; return v; } // CSI/O: read clears EF
            case 0x0B: return this.trdr;
            case 0x0C:
                if (this.tif0Latch) { this.tcr &= ~0x40; this.tif0Latch = false; }
                return this.tmdr0 & 0xFF;
            case 0x0D:
                if (this.tif0Latch) { this.tcr &= ~0x40; this.tif0Latch = false; }
                return (this.tmdr0 >> 8) & 0xFF;
            case 0x0E: return this.rldr0 & 0xFF;
            case 0x0F: return (this.rldr0 >> 8) & 0xFF;
            case 0x10: {
                const v = this.tcr;
                // Reading TCR arms TIF clearing (cleared on subsequent TMDR read)
                this.tif0Latch = true; this.tif1Latch = true;
                return v;
            }
            case 0x14:
                if (this.tif1Latch) { this.tcr &= ~0x80; this.tif1Latch = false; }
                return this.tmdr1 & 0xFF;
            case 0x15:
                if (this.tif1Latch) { this.tcr &= ~0x80; this.tif1Latch = false; }
                return (this.tmdr1 >> 8) & 0xFF;
            case 0x16: return this.rldr1 & 0xFF;
            case 0x17: return (this.rldr1 >> 8) & 0xFF;
            case 0x18: return (0x100 - ((this.tstates / 10) & 0xFF)) & 0xFF; // FRC (free running, down count)
            case 0x20: return this.sar0 & 0xFF;
            case 0x21: return (this.sar0 >> 8) & 0xFF;
            case 0x22: return (this.sar0 >> 16) & 0x0F;
            case 0x23: return this.dar0 & 0xFF;
            case 0x24: return (this.dar0 >> 8) & 0xFF;
            case 0x25: return (this.dar0 >> 16) & 0x0F;
            case 0x26: return this.bcr0 & 0xFF;
            case 0x27: return (this.bcr0 >> 8) & 0xFF;
            case 0x28: return this.mar1 & 0xFF;
            case 0x29: return (this.mar1 >> 8) & 0xFF;
            case 0x2A: return (this.mar1 >> 16) & 0x0F;
            case 0x2B: return this.iar1 & 0xFF;
            case 0x2C: return (this.iar1 >> 8) & 0xFF;
            case 0x2E: return this.bcr1 & 0xFF;
            case 0x2F: return (this.bcr1 >> 8) & 0xFF;
            case 0x30: return this.dstat;
            case 0x31: return this.dmode;
            case 0x32: return this.dcntl;
            case 0x33: return this.il;
            case 0x34: return this.itc;
            case 0x36: return this.rcr;
            case 0x38: return this.cbr;
            case 0x39: return this.bbr;
            case 0x3A: return this.cbar;
            case 0x3E: return this.omcr;
            case 0x3F: return this.icr;
            default: return 0xFF;
        }
    }

    writeInternal(r, v) {
        switch (r) {
            case 0x00: this.asci.cntla0 = v; break;
            case 0x01: this.asci.cntla1 = v; break;
            case 0x02: this.asci.cntlb0 = v; break;
            case 0x03: this.asci.cntlb1 = v; break;
            case 0x04: this.asci.stat0 = (this.asci.stat0 & 0xF6) | (v & 0x09); break; // RIE/TIE writable
            case 0x05: this.asci.stat1 = (this.asci.stat1 & 0xF6) | (v & 0x09); break;
            case 0x06:
                this.asci.tdr0 = v;
                this.asci.stat0 &= ~0x02;              // TDRE low while shifting
                this.asci.tx0 = this.asciByteCycles;
                if (this.bus.midiOut) this.bus.midiOut(0, v);
                break;
            case 0x07:
                this.asci.tdr1 = v;
                this.asci.stat1 &= ~0x02;
                this.asci.tx1 = this.asciByteCycles;
                if (this.bus.midiOut) this.bus.midiOut(1, v);
                break;
            case 0x0A: {
                // EF (bit7) is read-only; TE/RE (bits 4/5) start a shift
                this.cntr = (this.cntr & 0x80) | (v & 0x7F);
                if ((this.cntr & 0x30) && this.csioShift === 0) {
                    const ss = this.cntr & 0x07;
                    this.csioShift = ss === 7 ? 160 : 8 * 20 * (1 << ss);
                }
                break;
            }
            case 0x0B: this.trdr = v; break;
            case 0x0C: this.tmdr0 = (this.tmdr0 & 0xFF00) | v; break;
            case 0x0D: this.tmdr0 = (this.tmdr0 & 0x00FF) | (v << 8); break;
            case 0x0E: this.rldr0 = (this.rldr0 & 0xFF00) | v; break;
            case 0x0F: this.rldr0 = (this.rldr0 & 0x00FF) | (v << 8); break;
            case 0x10:
                // TIF bits (6,7) are read-only
                this.tcr = (this.tcr & 0xC0) | (v & 0x3F);
                break;
            case 0x14: this.tmdr1 = (this.tmdr1 & 0xFF00) | v; break;
            case 0x15: this.tmdr1 = (this.tmdr1 & 0x00FF) | (v << 8); break;
            case 0x16: this.rldr1 = (this.rldr1 & 0xFF00) | v; break;
            case 0x17: this.rldr1 = (this.rldr1 & 0x00FF) | (v << 8); break;
            case 0x20: this.sar0 = (this.sar0 & 0xFFF00) | v; break;
            case 0x21: this.sar0 = (this.sar0 & 0xF00FF) | (v << 8); break;
            case 0x22: this.sar0 = (this.sar0 & 0x0FFFF) | ((v & 0x0F) << 16); break;
            case 0x23: this.dar0 = (this.dar0 & 0xFFF00) | v; break;
            case 0x24: this.dar0 = (this.dar0 & 0xF00FF) | (v << 8); break;
            case 0x25: this.dar0 = (this.dar0 & 0x0FFFF) | ((v & 0x0F) << 16); break;
            case 0x26: this.bcr0 = (this.bcr0 & 0xFF00) | v; break;
            case 0x27: this.bcr0 = (this.bcr0 & 0x00FF) | (v << 8); break;
            case 0x28: this.mar1 = (this.mar1 & 0xFFF00) | v; break;
            case 0x29: this.mar1 = (this.mar1 & 0xF00FF) | (v << 8); break;
            case 0x2A: this.mar1 = (this.mar1 & 0x0FFFF) | ((v & 0x0F) << 16); break;
            case 0x2B: this.iar1 = (this.iar1 & 0xFF00) | v; break;
            case 0x2C: this.iar1 = (this.iar1 & 0x00FF) | (v << 8); break;
            case 0x2E: this.bcr1 = (this.bcr1 & 0xFF00) | v; break;
            case 0x2F: this.bcr1 = (this.bcr1 & 0x00FF) | (v << 8); break;
            case 0x30:
                // DSTAT: DE1(7) DE0(6) /DWE1(5) /DWE0(4) DIE1(3) DIE0(2) - DME(0)
                // DE bits only change when the matching /DWE bit is written 0.
                if ((v & 0x10) === 0) this.dstat = (this.dstat & ~0x40) | (v & 0x40);
                if ((v & 0x20) === 0) this.dstat = (this.dstat & ~0x80) | (v & 0x80);
                this.dstat = (this.dstat & 0xF0) | (v & 0x0C) | 0x30;
                if (this.dstat & 0xC0) this.dstat |= 0x01; // DME set when a channel enabled
                if (this.dstat & 0x40) this.runDMA0();
                break;
            case 0x31: this.dmode = v & 0x3E; break;
            case 0x32: this.dcntl = v; break;
            case 0x33: this.il = v & 0xE0; break;
            case 0x34:
                // ITC: writing 0 to UFO/TRAP clears; ITE bits writable (0-2)
                this.itc = (this.itc & 0x80 & v) | (v & 0x07);
                break;
            case 0x36: this.rcr = v; break;
            case 0x38: this.cbr = v; break;
            case 0x39: this.bbr = v; break;
            case 0x3A: this.cbar = v; break;
            case 0x3E: this.omcr = v; break;
            case 0x3F: this.icr = v & 0xE0; break;
            default: break;
        }
    }

    // ---------------- DMA ----------------
    /** Channel 0: memory<->memory. The MC-500 ROM uses burst mode, which
     *  stalls the CPU for the whole transfer, so completing it synchronously
     *  is behaviorally correct. */
    runDMA0() {
        if (!(this.dstat & 0x40) || !(this.dstat & 0x01)) return;
        const total = this.bcr0 === 0 ? 0x10000 : this.bcr0;
        let count = total;
        const dm = (this.dmode >> 4) & 3;  // dest mode
        const sm = (this.dmode >> 2) & 3;  // src mode
        while (count > 0) {
            const v = this.bus.physRead(this.sar0 & 0xFFFFF);
            this.bus.physWrite(this.dar0 & 0xFFFFF, v);
            if (sm === 0) this.sar0++; else if (sm === 1) this.sar0--;
            if (dm === 0) this.dar0++; else if (dm === 1) this.dar0--;
            count--;
        }
        this.sar0 &= 0xFFFFF; this.dar0 &= 0xFFFFF;
        this.bcr0 = 0;
        this.tstates += total * 6;
        this.dstat &= ~0x40;               // DE0 clears on completion
        if (!(this.dstat & 0xC0)) this.dstat &= ~0x01;
        if (this.dstat & 0x04) this.dmaIrq0 = true;  // DIE0
    }

    /** Channel 1: memory<->I/O, driven by external DREQ1 (FDC DRQ).
     *  The machine calls this when DRQ is asserted. Returns true if a byte
     *  was moved. */
    dreq1() {
        if (!(this.dstat & 0x80) || !(this.dstat & 0x01)) return false;
        // DCNTL bits 1-0 = DIM1,DIM0: 00 M->IO MAR1+, 01 M->IO MAR1-,
        // 10 IO->M MAR1+, 11 IO->M MAR1-
        const dim = this.dcntl & 3;
        if (dim & 2) {
            // I/O -> memory
            const v = this.bus.ioRead(this.iar1 & 0xFFFF) & 0xFF;
            this.bus.physWrite(this.mar1 & 0xFFFFF, v);
        } else {
            // memory -> I/O
            const v = this.bus.physRead(this.mar1 & 0xFFFFF);
            this.bus.ioWrite(this.iar1 & 0xFFFF, v);
        }
        if (dim === 0 || dim === 2) this.mar1++; else this.mar1--;
        this.mar1 &= 0xFFFFF;
        this.bcr1 = (this.bcr1 - 1) & 0xFFFF;
        this.tstates += 6;
        if (this.bcr1 === 0) {
            this.dstat &= ~0x80;           // DE1 clears
            if (!(this.dstat & 0xC0)) this.dstat &= ~0x01;
            if (this.dstat & 0x08) this.dmaIrq1 = true; // DIE1
        }
        return true;
    }

    // ---------------- PRT timers + CSI/O ----------------
    tickTimers(cycles) {
        if (this.asci.tx0 > 0) {
            this.asci.tx0 -= cycles;
            if (this.asci.tx0 <= 0) { this.asci.tx0 = 0; this.asci.stat0 |= 0x02; }
        }
        if (this.asci.tx1 > 0) {
            this.asci.tx1 -= cycles;
            if (this.asci.tx1 <= 0) { this.asci.tx1 = 0; this.asci.stat1 |= 0x02; }
        }
        if (this.csioShift > 0) {
            this.csioShift -= cycles;
            if (this.csioShift <= 0) {
                this.csioShift = 0;
                this.cntr = (this.cntr & ~0x30) | 0x80; // EF set, TE/RE cleared
            }
        }
        this.prtPrescale += cycles;
        while (this.prtPrescale >= 20) {
            this.prtPrescale -= 20;
            if (this.tcr & 0x01) { // TDE0
                this.tmdr0 = (this.tmdr0 - 1) & 0xFFFF;
                if (this.tmdr0 === 0) {
                    this.tmdr0 = this.rldr0;
                    this.tcr |= 0x40; // TIF0
                }
            }
            if (this.tcr & 0x02) { // TDE1
                this.tmdr1 = (this.tmdr1 - 1) & 0xFFFF;
                if (this.tmdr1 === 0) {
                    this.tmdr1 = this.rldr1;
                    this.tcr |= 0x80; // TIF1
                }
            }
        }
    }

    // ---------------- Interrupts ----------------
    /** Take a vectored internal/external interrupt via the IL table. */
    takeVectored(offset) {
        this.halted = false;
        this.iff1 = false;
        this.iff2 = false;
        this.push16(this.pc);
        const vecAddr = ((this.i << 8) | (this.il & 0xE0) | offset) & 0xFFFF;
        this.pc = this.read16(vecAddr);
        this.tstates += 19;
    }

    checkInterrupts() {
        // NMI (edge)
        if (this.nmiLine && !this.nmiSeen) {
            this.nmiSeen = true;
            this.halted = false;
            this.iff2 = this.iff1; this.iff1 = false;
            this.push16(this.pc);
            this.pc = 0x0066;
            this.tstates += 11;
            return true;
        }
        if (!this.nmiLine) this.nmiSeen = false;

        if (!this.iff1 || this.pendingEI) return false;

        // INT0 (external, maskable, IM-dependent) — highest priority
        if (this.int0Line && (this.itc & 0x01)) {
            this.halted = false;
            this.iff1 = this.iff2 = false;
            this.push16(this.pc);
            if (this.im === 2) {
                this.pc = this.read16(((this.i << 8) | 0xFF) & 0xFFFF);
            } else {
                this.pc = 0x0038;
            }
            this.tstates += 13;
            return true;
        }
        // INT1, INT2 (external, via vector table)
        if (this.int1Line && (this.itc & 0x02)) { this.takeVectored(0x00); return true; }
        if (this.int2Line && (this.itc & 0x04)) { this.takeVectored(0x02); return true; }
        // PRT0
        if ((this.tcr & 0x40) && (this.tcr & 0x10)) { this.takeVectored(0x04); return true; }
        // PRT1
        if ((this.tcr & 0x80) && (this.tcr & 0x20)) { this.takeVectored(0x06); return true; }
        // DMA0
        if (this.dmaIrq0) { this.dmaIrq0 = false; this.takeVectored(0x08); return true; }
        // DMA1
        if (this.dmaIrq1) { this.dmaIrq1 = false; this.takeVectored(0x0A); return true; }
        // CSI/O: EF && EIE
        if ((this.cntr & 0x80) && (this.cntr & 0x40)) { this.takeVectored(0x0C); return true; }
        // ASCI0: RX (RDRF && RIE) or TX (TDRE && TIE)
        if (((this.asci.stat0 & 0x80) && (this.asci.stat0 & 0x08)) ||
            ((this.asci.stat0 & 0x02) && (this.asci.stat0 & 0x01))) { this.takeVectored(0x0E); return true; }
        if (((this.asci.stat1 & 0x80) && (this.asci.stat1 & 0x08)) ||
            ((this.asci.stat1 & 0x02) && (this.asci.stat1 & 0x01))) { this.takeVectored(0x10); return true; }
        return false;
    }

    // ---------------- ALU helpers ----------------
    add8(v, carry) {
        const c = carry ? 1 : 0;
        const r = this.a + v + c;
        const rb = r & 0xFF;
        this.f = SZ[rb]
            | ((r & 0x100) ? FLAG_C : 0)
            | (((this.a ^ v ^ rb) & 0x10) ? FLAG_H : 0)
            | ((~(this.a ^ v) & (this.a ^ rb) & 0x80) ? FLAG_PV : 0);
        this.a = rb;
    }
    sub8(v, carry, keepA) {
        const c = carry ? 1 : 0;
        const r = this.a - v - c;
        const rb = r & 0xFF;
        let f = (SZ[rb] & ~(FLAG_X | FLAG_Y)) | FLAG_N
            | ((r & 0x100) ? FLAG_C : 0)
            | (((this.a ^ v ^ rb) & 0x10) ? FLAG_H : 0)
            | (((this.a ^ v) & (this.a ^ rb) & 0x80) ? FLAG_PV : 0);
        // X/Y come from result for SUB, from operand for CP
        f |= keepA ? (v & (FLAG_X | FLAG_Y)) : (rb & (FLAG_X | FLAG_Y));
        this.f = f;
        if (!keepA) this.a = rb;
    }
    and8(v) { this.a &= v; this.f = SZP[this.a] | FLAG_H; }
    or8(v) { this.a |= v; this.f = SZP[this.a]; }
    xor8(v) { this.a ^= v; this.f = SZP[this.a]; }
    inc8(v) {
        const r = (v + 1) & 0xFF;
        this.f = (this.f & FLAG_C) | SZ[r]
            | ((r & 0x0F) === 0 ? FLAG_H : 0)
            | (r === 0x80 ? FLAG_PV : 0);
        return r;
    }
    dec8(v) {
        const r = (v - 1) & 0xFF;
        this.f = (this.f & FLAG_C) | SZ[r] | FLAG_N
            | ((r & 0x0F) === 0x0F ? FLAG_H : 0)
            | (r === 0x7F ? FLAG_PV : 0);
        return r;
    }
    add16(a, b) {
        const r = a + b;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV))
            | ((r & 0x10000) ? FLAG_C : 0)
            | (((a ^ b ^ r) & 0x1000) ? FLAG_H : 0)
            | ((r >> 8) & (FLAG_X | FLAG_Y));
        return r & 0xFFFF;
    }
    adc16(v) {
        const a = this.hl, c = (this.f & FLAG_C) ? 1 : 0;
        const r = a + v + c;
        const rw = r & 0xFFFF;
        this.f = ((rw & 0x8000) ? FLAG_S : 0)
            | (rw === 0 ? FLAG_Z : 0)
            | ((r & 0x10000) ? FLAG_C : 0)
            | (((a ^ v ^ rw) & 0x1000) ? FLAG_H : 0)
            | ((~(a ^ v) & (a ^ rw) & 0x8000) ? FLAG_PV : 0)
            | ((rw >> 8) & (FLAG_X | FLAG_Y));
        this.hl = rw;
    }
    sbc16(v) {
        const a = this.hl, c = (this.f & FLAG_C) ? 1 : 0;
        const r = a - v - c;
        const rw = r & 0xFFFF;
        this.f = FLAG_N
            | ((rw & 0x8000) ? FLAG_S : 0)
            | (rw === 0 ? FLAG_Z : 0)
            | ((r & 0x10000) ? FLAG_C : 0)
            | (((a ^ v ^ rw) & 0x1000) ? FLAG_H : 0)
            | (((a ^ v) & (a ^ rw) & 0x8000) ? FLAG_PV : 0)
            | ((rw >> 8) & (FLAG_X | FLAG_Y));
        this.hl = rw;
    }

    // rotates/shifts (CB set) — return result, set flags
    rlc(v) { const r = ((v << 1) | (v >> 7)) & 0xFF; this.f = SZP[r] | ((v & 0x80) ? FLAG_C : 0); return r; }
    rrc(v) { const r = ((v >> 1) | (v << 7)) & 0xFF; this.f = SZP[r] | (v & FLAG_C); return r; }
    rl(v) { const c = (this.f & FLAG_C) ? 1 : 0; const r = ((v << 1) | c) & 0xFF; this.f = SZP[r] | ((v & 0x80) ? FLAG_C : 0); return r; }
    rr(v) { const c = (this.f & FLAG_C) ? 0x80 : 0; const r = (v >> 1) | c; this.f = SZP[r] | (v & FLAG_C); return r; }
    sla(v) { const r = (v << 1) & 0xFF; this.f = SZP[r] | ((v & 0x80) ? FLAG_C : 0); return r; }
    sra(v) { const r = (v >> 1) | (v & 0x80); this.f = SZP[r] | (v & FLAG_C); return r; }
    sll(v) { const r = ((v << 1) | 1) & 0xFF; this.f = SZP[r] | ((v & 0x80) ? FLAG_C : 0); return r; }
    srl(v) { const r = v >> 1; this.f = SZP[r] | (v & FLAG_C); return r; }

    daa() {
        let a = this.a, f = this.f;
        let add = 0, carry = f & FLAG_C;
        if ((f & FLAG_H) || (a & 0x0F) > 9) add |= 0x06;
        if (carry || a > 0x99) { add |= 0x60; carry = FLAG_C; }
        const before = a;
        a = (f & FLAG_N) ? (a - add) & 0xFF : (a + add) & 0xFF;
        this.f = SZP[a] | carry | (f & FLAG_N)
            | (((before ^ a) & 0x10) ? FLAG_H : 0);
        this.a = a;
    }

    // condition codes
    cond(cc) {
        switch (cc) {
            case 0: return !(this.f & FLAG_Z);
            case 1: return !!(this.f & FLAG_Z);
            case 2: return !(this.f & FLAG_C);
            case 3: return !!(this.f & FLAG_C);
            case 4: return !(this.f & FLAG_PV);
            case 5: return !!(this.f & FLAG_PV);
            case 6: return !(this.f & FLAG_S);
            case 7: return !!(this.f & FLAG_S);
        }
    }

    getReg(idx) {
        switch (idx) {
            case 0: return this.b; case 1: return this.c; case 2: return this.d;
            case 3: return this.e; case 4: return this.h; case 5: return this.l;
            case 6: return this.read8(this.hl); case 7: return this.a;
        }
    }
    setReg(idx, v) {
        v &= 0xFF;
        switch (idx) {
            case 0: this.b = v; break; case 1: this.c = v; break; case 2: this.d = v; break;
            case 3: this.e = v; break; case 4: this.h = v; break; case 5: this.l = v; break;
            case 6: this.write8(this.hl, v); break; case 7: this.a = v; break;
        }
    }

    // ---------------- main step ----------------
    step() {
        const start = this.tstates;

        if (this.pendingEI) {
            this.pendingEI = false;
            this.iff1 = this.iff2 = true;
        } else if (this.checkInterrupts()) {
            this.tickTimers(this.tstates - start);
            return this.tstates - start;
        }

        if (this.halted) {
            this.tstates += 4;
            this.tickTimers(4);
            return 4;
        }

        const op = this.fetch8();
        this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
        this.execute(op);
        const used = this.tstates - start;
        this.tickTimers(used);
        return used;
    }

    execute(op) {
        switch (op) {
            case 0x00: this.tstates += 4; break; // NOP
            case 0x01: this.bc = this.fetch16(); this.tstates += 10; break;
            case 0x02: this.write8(this.bc, this.a); this.tstates += 7; break;
            case 0x03: this.bc = (this.bc + 1) & 0xFFFF; this.tstates += 6; break;
            case 0x04: this.b = this.inc8(this.b); this.tstates += 4; break;
            case 0x05: this.b = this.dec8(this.b); this.tstates += 4; break;
            case 0x06: this.b = this.fetch8(); this.tstates += 7; break;
            case 0x07: { const a = this.a; this.a = ((a << 1) | (a >> 7)) & 0xFF; this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | ((a & 0x80) ? FLAG_C : 0) | (this.a & (FLAG_X | FLAG_Y)); this.tstates += 4; break; } // RLCA
            case 0x08: { const t = this.af; this.af = (this.a_ << 8) | this.f_; this.a_ = (t >> 8) & 0xFF; this.f_ = t & 0xFF; this.tstates += 4; break; } // EX AF,AF'
            case 0x09: this.hl = this.add16(this.hl, this.bc); this.tstates += 11; break;
            case 0x0A: this.a = this.read8(this.bc); this.tstates += 7; break;
            case 0x0B: this.bc = (this.bc - 1) & 0xFFFF; this.tstates += 6; break;
            case 0x0C: this.c = this.inc8(this.c); this.tstates += 4; break;
            case 0x0D: this.c = this.dec8(this.c); this.tstates += 4; break;
            case 0x0E: this.c = this.fetch8(); this.tstates += 7; break;
            case 0x0F: { const a = this.a; this.a = ((a >> 1) | (a << 7)) & 0xFF; this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | (a & FLAG_C) | (this.a & (FLAG_X | FLAG_Y)); this.tstates += 4; break; } // RRCA
            case 0x10: { const d = this.fetch8(); this.b = (this.b - 1) & 0xFF; if (this.b !== 0) { this.pc = (this.pc + ((d << 24) >> 24)) & 0xFFFF; this.tstates += 13; } else this.tstates += 8; break; } // DJNZ
            case 0x11: this.de = this.fetch16(); this.tstates += 10; break;
            case 0x12: this.write8(this.de, this.a); this.tstates += 7; break;
            case 0x13: this.de = (this.de + 1) & 0xFFFF; this.tstates += 6; break;
            case 0x14: this.d = this.inc8(this.d); this.tstates += 4; break;
            case 0x15: this.d = this.dec8(this.d); this.tstates += 4; break;
            case 0x16: this.d = this.fetch8(); this.tstates += 7; break;
            case 0x17: { const a = this.a; const c = (this.f & FLAG_C) ? 1 : 0; this.a = ((a << 1) | c) & 0xFF; this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | ((a & 0x80) ? FLAG_C : 0) | (this.a & (FLAG_X | FLAG_Y)); this.tstates += 4; break; } // RLA
            case 0x18: { const d = this.fetch8(); this.pc = (this.pc + ((d << 24) >> 24)) & 0xFFFF; this.tstates += 12; break; } // JR
            case 0x19: this.hl = this.add16(this.hl, this.de); this.tstates += 11; break;
            case 0x1A: this.a = this.read8(this.de); this.tstates += 7; break;
            case 0x1B: this.de = (this.de - 1) & 0xFFFF; this.tstates += 6; break;
            case 0x1C: this.e = this.inc8(this.e); this.tstates += 4; break;
            case 0x1D: this.e = this.dec8(this.e); this.tstates += 4; break;
            case 0x1E: this.e = this.fetch8(); this.tstates += 7; break;
            case 0x1F: { const a = this.a; const c = (this.f & FLAG_C) ? 0x80 : 0; this.a = (a >> 1) | c; this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | (a & FLAG_C) | (this.a & (FLAG_X | FLAG_Y)); this.tstates += 4; break; } // RRA
            case 0x20: case 0x28: case 0x30: case 0x38: { // JR cc
                const cc = (op >> 3) & 3;
                const take = this.cond(cc);
                const d = this.fetch8();
                if (take) { this.pc = (this.pc + ((d << 24) >> 24)) & 0xFFFF; this.tstates += 12; }
                else this.tstates += 7;
                break;
            }
            case 0x21: this.hl = this.fetch16(); this.tstates += 10; break;
            case 0x22: { const a = this.fetch16(); this.write16(a, this.hl); this.tstates += 16; break; }
            case 0x23: this.hl = (this.hl + 1) & 0xFFFF; this.tstates += 6; break;
            case 0x24: this.h = this.inc8(this.h); this.tstates += 4; break;
            case 0x25: this.h = this.dec8(this.h); this.tstates += 4; break;
            case 0x26: this.h = this.fetch8(); this.tstates += 7; break;
            case 0x27: this.daa(); this.tstates += 4; break;
            case 0x29: this.hl = this.add16(this.hl, this.hl); this.tstates += 11; break;
            case 0x2A: { const a = this.fetch16(); this.hl = this.read16(a); this.tstates += 16; break; }
            case 0x2B: this.hl = (this.hl - 1) & 0xFFFF; this.tstates += 6; break;
            case 0x2C: this.l = this.inc8(this.l); this.tstates += 4; break;
            case 0x2D: this.l = this.dec8(this.l); this.tstates += 4; break;
            case 0x2E: this.l = this.fetch8(); this.tstates += 7; break;
            case 0x2F: this.a = (~this.a) & 0xFF; this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV | FLAG_C)) | FLAG_H | FLAG_N | (this.a & (FLAG_X | FLAG_Y)); this.tstates += 4; break; // CPL
            case 0x31: this.sp = this.fetch16(); this.tstates += 10; break;
            case 0x32: { const a = this.fetch16(); this.write8(a, this.a); this.tstates += 13; break; }
            case 0x33: this.sp = (this.sp + 1) & 0xFFFF; this.tstates += 6; break;
            case 0x34: { const v = this.inc8(this.read8(this.hl)); this.write8(this.hl, v); this.tstates += 11; break; }
            case 0x35: { const v = this.dec8(this.read8(this.hl)); this.write8(this.hl, v); this.tstates += 11; break; }
            case 0x36: this.write8(this.hl, this.fetch8()); this.tstates += 10; break;
            case 0x37: this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | FLAG_C | (this.a & (FLAG_X | FLAG_Y)); this.tstates += 4; break; // SCF
            case 0x39: this.hl = this.add16(this.hl, this.sp); this.tstates += 11; break;
            case 0x3A: { const a = this.fetch16(); this.a = this.read8(a); this.tstates += 13; break; }
            case 0x3B: this.sp = (this.sp - 1) & 0xFFFF; this.tstates += 6; break;
            case 0x3C: this.a = this.inc8(this.a); this.tstates += 4; break;
            case 0x3D: this.a = this.dec8(this.a); this.tstates += 4; break;
            case 0x3E: this.a = this.fetch8(); this.tstates += 7; break;
            case 0x3F: { const c = this.f & FLAG_C; this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | (c ? FLAG_H : FLAG_C) | (this.a & (FLAG_X | FLAG_Y)); this.tstates += 4; break; } // CCF
            case 0x76: this.halted = true; this.tstates += 4; break; // HALT
            default:
                if (op >= 0x40 && op <= 0x7F) { // LD r,r'
                    const dst = (op >> 3) & 7, src = op & 7;
                    this.setReg(dst, this.getReg(src));
                    this.tstates += (dst === 6 || src === 6) ? 7 : 4;
                } else if (op >= 0x80 && op <= 0xBF) { // ALU A,r
                    const src = op & 7;
                    const v = this.getReg(src);
                    this.aluOp((op >> 3) & 7, v);
                    this.tstates += (src === 6) ? 7 : 4;
                } else {
                    this.executeHigh(op);
                }
        }
    }

    aluOp(idx, v) {
        switch (idx) {
            case 0: this.add8(v, false); break;
            case 1: this.add8(v, !!(this.f & FLAG_C)); break;
            case 2: this.sub8(v, false, false); break;
            case 3: this.sub8(v, !!(this.f & FLAG_C), false); break;
            case 4: this.and8(v); break;
            case 5: this.xor8(v); break;
            case 6: this.or8(v); break;
            case 7: this.sub8(v, false, true); break; // CP
        }
    }

    executeHigh(op) {
        switch (op) {
            case 0xC0: case 0xC8: case 0xD0: case 0xD8:
            case 0xE0: case 0xE8: case 0xF0: case 0xF8: { // RET cc
                const cc = (op >> 3) & 7;
                if (this.cond(cc)) { this.pc = this.pop16(); this.tstates += 11; }
                else this.tstates += 5;
                break;
            }
            case 0xC1: this.bc = this.pop16(); this.tstates += 10; break;
            case 0xC2: case 0xCA: case 0xD2: case 0xDA:
            case 0xE2: case 0xEA: case 0xF2: case 0xFA: { // JP cc,nn
                const cc = (op >> 3) & 7;
                const a = this.fetch16();
                if (this.cond(cc)) this.pc = a;
                this.tstates += 10;
                break;
            }
            case 0xC3: this.pc = this.fetch16(); this.tstates += 10; break;
            case 0xC4: case 0xCC: case 0xD4: case 0xDC:
            case 0xE4: case 0xEC: case 0xF4: case 0xFC: { // CALL cc,nn
                const cc = (op >> 3) & 7;
                const a = this.fetch16();
                if (this.cond(cc)) { this.push16(this.pc); this.pc = a; this.tstates += 17; }
                else this.tstates += 10;
                break;
            }
            case 0xC5: this.push16(this.bc); this.tstates += 11; break;
            case 0xC6: this.add8(this.fetch8(), false); this.tstates += 7; break;
            case 0xC7: case 0xCF: case 0xD7: case 0xDF:
            case 0xE7: case 0xEF: case 0xF7: case 0xFF: // RST
                this.push16(this.pc);
                this.pc = op & 0x38;
                this.tstates += 11;
                break;
            case 0xC9: this.pc = this.pop16(); this.tstates += 10; break;
            case 0xCB: this.executeCB(); break;
            case 0xCD: { const a = this.fetch16(); this.push16(this.pc); this.pc = a; this.tstates += 17; break; }
            case 0xCE: this.add8(this.fetch8(), !!(this.f & FLAG_C)); this.tstates += 7; break;
            case 0xD1: this.de = this.pop16(); this.tstates += 10; break;
            case 0xD3: { const p = this.fetch8(); this.ioOut((this.a << 8) | p, this.a); this.tstates += 11; break; }
            case 0xD5: this.push16(this.de); this.tstates += 11; break;
            case 0xD6: this.sub8(this.fetch8(), false, false); this.tstates += 7; break;
            case 0xD9: { // EXX
                let t;
                t = this.b; this.b = this.b_; this.b_ = t;
                t = this.c; this.c = this.c_; this.c_ = t;
                t = this.d; this.d = this.d_; this.d_ = t;
                t = this.e; this.e = this.e_; this.e_ = t;
                t = this.h; this.h = this.h_; this.h_ = t;
                t = this.l; this.l = this.l_; this.l_ = t;
                this.tstates += 4;
                break;
            }
            case 0xDB: { const p = this.fetch8(); this.a = this.ioIn((this.a << 8) | p); this.tstates += 11; break; }
            case 0xDD: this.executeIndex('ix'); break;
            case 0xDE: this.sub8(this.fetch8(), !!(this.f & FLAG_C), false); this.tstates += 7; break;
            case 0xE1: this.hl = this.pop16(); this.tstates += 10; break;
            case 0xE3: { const t = this.read16(this.sp); this.write16(this.sp, this.hl); this.hl = t; this.tstates += 19; break; } // EX (SP),HL
            case 0xE5: this.push16(this.hl); this.tstates += 11; break;
            case 0xE6: this.and8(this.fetch8()); this.tstates += 7; break;
            case 0xE9: this.pc = this.hl; this.tstates += 4; break; // JP (HL)
            case 0xEB: { const t = this.de; this.de = this.hl; this.hl = t; this.tstates += 4; break; } // EX DE,HL
            case 0xED: this.executeED(); break;
            case 0xEE: this.xor8(this.fetch8()); this.tstates += 7; break;
            case 0xF1: this.af = this.pop16(); this.tstates += 10; break;
            case 0xF3: this.iff1 = this.iff2 = false; this.tstates += 4; break; // DI
            case 0xF5: this.push16(this.af); this.tstates += 11; break;
            case 0xF6: this.or8(this.fetch8()); this.tstates += 7; break;
            case 0xF9: this.sp = this.hl; this.tstates += 6; break;
            case 0xFB: this.pendingEI = true; this.tstates += 4; break; // EI
            case 0xFD: this.executeIndex('iy'); break;
            case 0xFE: this.sub8(this.fetch8(), false, true); this.tstates += 7; break;
            default:
                this.undefinedOp([op]);
        }
    }

    executeCB() {
        const op = this.fetch8();
        this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
        const reg = op & 7;
        const kind = op >> 6;
        const bit = (op >> 3) & 7;
        if (kind === 0) { // rotate/shift
            let v = this.getReg(reg);
            v = this.rotOp(bit, v);
            this.setReg(reg, v);
            this.tstates += reg === 6 ? 15 : 8;
        } else if (kind === 1) { // BIT
            const v = this.getReg(reg);
            const set = v & (1 << bit);
            this.f = (this.f & FLAG_C) | FLAG_H
                | (set ? 0 : (FLAG_Z | FLAG_PV))
                | (set & 0x80 ? FLAG_S : 0)
                | (v & (FLAG_X | FLAG_Y));
            this.tstates += reg === 6 ? 12 : 8;
        } else if (kind === 2) { // RES
            this.setReg(reg, this.getReg(reg) & ~(1 << bit));
            this.tstates += reg === 6 ? 15 : 8;
        } else { // SET
            this.setReg(reg, this.getReg(reg) | (1 << bit));
            this.tstates += reg === 6 ? 15 : 8;
        }
    }

    rotOp(idx, v) {
        switch (idx) {
            case 0: return this.rlc(v);
            case 1: return this.rrc(v);
            case 2: return this.rl(v);
            case 3: return this.rr(v);
            case 4: return this.sla(v);
            case 5: return this.sra(v);
            case 6: return this.sll(v);
            case 7: return this.srl(v);
        }
    }

    executeIndex(regName) {
        const op = this.fetch8();
        this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
        const getIdx = () => this[regName];
        const setIdx = (v) => { this[regName] = v & 0xFFFF; };
        const dispAddr = () => {
            const d = (this.fetch8() << 24) >> 24;
            return (getIdx() + d) & 0xFFFF;
        };

        switch (op) {
            case 0x09: setIdx(this.add16(getIdx(), this.bc)); this.tstates += 15; break;
            case 0x19: setIdx(this.add16(getIdx(), this.de)); this.tstates += 15; break;
            case 0x21: setIdx(this.fetch16()); this.tstates += 14; break;
            case 0x22: { const a = this.fetch16(); this.write16(a, getIdx()); this.tstates += 20; break; }
            case 0x23: setIdx(getIdx() + 1); this.tstates += 10; break;
            case 0x24: setIdx((getIdx() & 0x00FF) | (this.inc8(getIdx() >> 8) << 8)); this.tstates += 8; break;
            case 0x25: setIdx((getIdx() & 0x00FF) | (this.dec8(getIdx() >> 8) << 8)); this.tstates += 8; break;
            case 0x26: setIdx((getIdx() & 0x00FF) | (this.fetch8() << 8)); this.tstates += 11; break;
            case 0x29: setIdx(this.add16(getIdx(), getIdx())); this.tstates += 15; break;
            case 0x2A: { const a = this.fetch16(); setIdx(this.read16(a)); this.tstates += 20; break; }
            case 0x2B: setIdx(getIdx() - 1); this.tstates += 10; break;
            case 0x2C: setIdx((getIdx() & 0xFF00) | this.inc8(getIdx() & 0xFF)); this.tstates += 8; break;
            case 0x2D: setIdx((getIdx() & 0xFF00) | this.dec8(getIdx() & 0xFF)); this.tstates += 8; break;
            case 0x2E: setIdx((getIdx() & 0xFF00) | this.fetch8()); this.tstates += 11; break;
            case 0x34: { const a = dispAddr(); this.write8(a, this.inc8(this.read8(a))); this.tstates += 23; break; }
            case 0x35: { const a = dispAddr(); this.write8(a, this.dec8(this.read8(a))); this.tstates += 23; break; }
            case 0x36: { const a = dispAddr(); this.write8(a, this.fetch8()); this.tstates += 19; break; }
            case 0x39: setIdx(this.add16(getIdx(), this.sp)); this.tstates += 15; break;
            case 0xE1: setIdx(this.pop16()); this.tstates += 14; break;
            case 0xE3: { const t = this.read16(this.sp); this.write16(this.sp, getIdx()); setIdx(t); this.tstates += 23; break; }
            case 0xE5: this.push16(getIdx()); this.tstates += 15; break;
            case 0xE9: this.pc = getIdx(); this.tstates += 8; break;
            case 0xF9: this.sp = getIdx(); this.tstates += 10; break;
            case 0xCB: { // DDCB/FDCB
                const d = (this.fetch8() << 24) >> 24;
                const sub = this.fetch8();
                const addr = (getIdx() + d) & 0xFFFF;
                const kind = sub >> 6, bit = (sub >> 3) & 7, reg = sub & 7;
                if (kind === 1) { // BIT
                    const v = this.read8(addr);
                    const set = v & (1 << bit);
                    this.f = (this.f & FLAG_C) | FLAG_H
                        | (set ? 0 : (FLAG_Z | FLAG_PV))
                        | (set & 0x80 ? FLAG_S : 0)
                        | ((addr >> 8) & (FLAG_X | FLAG_Y));
                    this.tstates += 20;
                } else {
                    let v = this.read8(addr);
                    if (kind === 0) v = this.rotOp(bit, v);
                    else if (kind === 2) v &= ~(1 << bit);
                    else v |= (1 << bit);
                    this.write8(addr, v);
                    if (reg !== 6) this.setReg(reg, v); // undocumented copy
                    this.tstates += 23;
                }
                break;
            }
            default:
                // LD r,(IX+d) / LD (IX+d),r / ALU A,(IX+d) and IXH/IXL variants
                if (op >= 0x40 && op <= 0x7F && op !== 0x76) {
                    const dst = (op >> 3) & 7, src = op & 7;
                    if (dst === 6) { // LD (IX+d),r
                        const a = dispAddr();
                        this.write8(a, this.getReg(src));
                        this.tstates += 19;
                    } else if (src === 6) { // LD r,(IX+d)
                        const a = dispAddr();
                        this.setReg(dst, this.read8(a));
                        this.tstates += 19;
                    } else {
                        // IXH/IXL register variants
                        const getR = (i2) => {
                            if (i2 === 4) return getIdx() >> 8;
                            if (i2 === 5) return getIdx() & 0xFF;
                            return this.getReg(i2);
                        };
                        const setR = (i2, v) => {
                            if (i2 === 4) setIdx((getIdx() & 0x00FF) | (v << 8));
                            else if (i2 === 5) setIdx((getIdx() & 0xFF00) | (v & 0xFF));
                            else this.setReg(i2, v);
                        };
                        setR(dst, getR(src));
                        this.tstates += 8;
                    }
                } else if (op >= 0x80 && op <= 0xBF) {
                    const src = op & 7;
                    let v;
                    if (src === 6) { v = this.read8(dispAddr()); this.tstates += 19; }
                    else if (src === 4) { v = getIdx() >> 8; this.tstates += 8; }
                    else if (src === 5) { v = getIdx() & 0xFF; this.tstates += 8; }
                    else { v = this.getReg(src); this.tstates += 8; }
                    this.aluOp((op >> 3) & 7, v);
                } else {
                    // Prefix applies to nothing: execute as normal opcode
                    this.execute(op);
                }
        }
    }

    executeED() {
        const op = this.fetch8();
        this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
        switch (op) {
            // ---- Z180-specific ----
            case 0x00: case 0x08: case 0x10: case 0x18:
            case 0x20: case 0x28: case 0x38: { // IN0 r,(n)
                const p = this.fetch8();
                const v = this.ioIn(p);
                this.setReg((op >> 3) & 7, v);
                this.f = (this.f & FLAG_C) | SZP[v];
                this.tstates += 12;
                break;
            }
            case 0x30: { // IN0 F,(n)? (reads and sets flags only)
                const p = this.fetch8();
                const v = this.ioIn(p);
                this.f = (this.f & FLAG_C) | SZP[v];
                this.tstates += 12;
                break;
            }
            case 0x01: case 0x09: case 0x11: case 0x19:
            case 0x21: case 0x29: case 0x31: case 0x39: { // OUT0 (n),r
                const p = this.fetch8();
                this.ioOut(p, this.getReg((op >> 3) & 7));
                this.tstates += 13;
                break;
            }
            case 0x04: case 0x0C: case 0x14: case 0x1C:
            case 0x24: case 0x2C: case 0x34: case 0x3C: { // TST r
                const v = this.getReg((op >> 3) & 7);
                const r = this.a & v;
                this.f = SZP[r] | FLAG_H;
                this.tstates += 7;
                break;
            }
            case 0x64: { // TST n
                const v = this.fetch8();
                const r = this.a & v;
                this.f = SZP[r] | FLAG_H;
                this.tstates += 9;
                break;
            }
            case 0x74: { // TSTIO n
                const v = this.fetch8();
                const r = this.ioIn(this.c) & v;
                this.f = SZP[r] | FLAG_H;
                this.tstates += 12;
                break;
            }
            case 0x4C: { const r = this.b * this.c; this.bc = r & 0xFFFF; this.tstates += 17; break; } // MLT BC
            case 0x5C: { const r = this.d * this.e; this.de = r & 0xFFFF; this.tstates += 17; break; } // MLT DE
            case 0x6C: { const r = this.h * this.l; this.hl = r & 0xFFFF; this.tstates += 17; break; } // MLT HL
            case 0x7C: { const r = ((this.sp >> 8) & 0xFF) * (this.sp & 0xFF); this.sp = r & 0xFFFF; this.tstates += 17; break; } // MLT SP
            case 0x76: this.halted = true; this.tstates += 8; break; // SLP (treat like halt)
            case 0x83: this.otim(1, false); break;  // OTIM
            case 0x93: this.otim(1, true); break;   // OTIMR
            case 0x8B: this.otim(-1, false); break; // OTDM
            case 0x9B: this.otim(-1, true); break;  // OTDMR

            // ---- Standard Z80 ED set ----
            case 0x40: case 0x48: case 0x50: case 0x58:
            case 0x60: case 0x68: case 0x78: { // IN r,(C)
                const v = this.ioIn(this.bc);
                this.setReg((op >> 3) & 7, v);
                this.f = (this.f & FLAG_C) | SZP[v];
                this.tstates += 12;
                break;
            }
            case 0x70: { const v = this.ioIn(this.bc); this.f = (this.f & FLAG_C) | SZP[v]; this.tstates += 12; break; } // IN (C)
            case 0x41: case 0x49: case 0x51: case 0x59:
            case 0x61: case 0x69: case 0x79: // OUT (C),r
                this.ioOut(this.bc, this.getReg((op >> 3) & 7));
                this.tstates += 12;
                break;
            case 0x71: this.ioOut(this.bc, 0); this.tstates += 12; break;
            case 0x42: this.sbc16(this.bc); this.tstates += 15; break;
            case 0x52: this.sbc16(this.de); this.tstates += 15; break;
            case 0x62: this.sbc16(this.hl); this.tstates += 15; break;
            case 0x72: this.sbc16(this.sp); this.tstates += 15; break;
            case 0x4A: this.adc16(this.bc); this.tstates += 15; break;
            case 0x5A: this.adc16(this.de); this.tstates += 15; break;
            case 0x6A: this.adc16(this.hl); this.tstates += 15; break;
            case 0x7A: this.adc16(this.sp); this.tstates += 15; break;
            case 0x43: { const a = this.fetch16(); this.write16(a, this.bc); this.tstates += 20; break; }
            case 0x53: { const a = this.fetch16(); this.write16(a, this.de); this.tstates += 20; break; }
            case 0x63: { const a = this.fetch16(); this.write16(a, this.hl); this.tstates += 20; break; }
            case 0x73: { const a = this.fetch16(); this.write16(a, this.sp); this.tstates += 20; break; }
            case 0x4B: { const a = this.fetch16(); this.bc = this.read16(a); this.tstates += 20; break; }
            case 0x5B: { const a = this.fetch16(); this.de = this.read16(a); this.tstates += 20; break; }
            case 0x6B: { const a = this.fetch16(); this.hl = this.read16(a); this.tstates += 20; break; }
            case 0x7B: { const a = this.fetch16(); this.sp = this.read16(a); this.tstates += 20; break; }
            case 0x45: this.pc = this.pop16(); this.iff1 = this.iff2; this.tstates += 14; break; // RETN
            case 0x4D: this.pc = this.pop16(); this.tstates += 14; break; // RETI
            case 0x55: case 0x5D: case 0x65: case 0x6D: case 0x75: case 0x7D:
                this.pc = this.pop16(); this.iff1 = this.iff2; this.tstates += 14; break; // RETN copies
            case 0x46: this.im = 0; this.tstates += 8; break;
            case 0x56: this.im = 1; this.tstates += 8; break;
            case 0x5E: this.im = 2; this.tstates += 8; break;
            case 0x47: this.i = this.a; this.tstates += 9; break; // LD I,A
            case 0x4F: this.r = this.a; this.tstates += 9; break; // LD R,A
            case 0x57: this.a = this.i; this.f = (this.f & FLAG_C) | SZ[this.a] | (this.iff2 ? FLAG_PV : 0); this.tstates += 9; break; // LD A,I
            case 0x5F: this.a = this.r; this.f = (this.f & FLAG_C) | SZ[this.a] | (this.iff2 ? FLAG_PV : 0); this.tstates += 9; break; // LD A,R
            case 0x67: { // RRD
                const m = this.read8(this.hl);
                const newM = ((this.a << 4) | (m >> 4)) & 0xFF;
                this.a = (this.a & 0xF0) | (m & 0x0F);
                this.write8(this.hl, newM);
                this.f = (this.f & FLAG_C) | SZP[this.a];
                this.tstates += 18;
                break;
            }
            case 0x6F: { // RLD
                const m = this.read8(this.hl);
                const newM = ((m << 4) | (this.a & 0x0F)) & 0xFF;
                this.a = (this.a & 0xF0) | (m >> 4);
                this.write8(this.hl, newM);
                this.f = (this.f & FLAG_C) | SZP[this.a];
                this.tstates += 18;
                break;
            }
            case 0xA0: this.ldi(1, false); break;
            case 0xA8: this.ldi(-1, false); break;
            case 0xB0: this.ldi(1, true); break;
            case 0xB8: this.ldi(-1, true); break;
            case 0xA1: this.cpi(1, false); break;
            case 0xA9: this.cpi(-1, false); break;
            case 0xB1: this.cpi(1, true); break;
            case 0xB9: this.cpi(-1, true); break;
            case 0xA2: this.ini(1, false); break;
            case 0xAA: this.ini(-1, false); break;
            case 0xB2: this.ini(1, true); break;
            case 0xBA: this.ini(-1, true); break;
            case 0xA3: this.outi(1, false); break;
            case 0xAB: this.outi(-1, false); break;
            case 0xB3: this.outi(1, true); break;
            case 0xBB: this.outi(-1, true); break;
            default:
                this.negOrIm(op);
        }
    }

    negOrIm(op) {
        // NEG and its undocumented mirrors: ED 44,4C?,54,5C?,64,6C?,74,7C?
        // (on Z180 4C/5C/6C/7C are MLT, 64/74 are TST/TSTIO — handled earlier)
        if (op === 0x44 || op === 0x54) {
            const a = this.a;
            this.a = 0;
            this.sub8(a, false, false);
            this.tstates += 8;
        } else if (op === 0x46 || op === 0x4E || op === 0x66 || op === 0x6E) {
            this.im = 0; this.tstates += 8;
        } else if (op === 0x56 || op === 0x76) {
            this.im = 1; this.tstates += 8;
        } else if (op === 0x5E || op === 0x7E) {
            this.im = 2; this.tstates += 8;
        } else {
            this.undefinedOp([0xED, op]);
        }
    }

    // block operations
    ldi(dir, repeat) {
        const v = this.read8(this.hl);
        this.write8(this.de, v);
        this.hl = (this.hl + dir) & 0xFFFF;
        this.de = (this.de + dir) & 0xFFFF;
        this.bc = (this.bc - 1) & 0xFFFF;
        const n = (v + this.a) & 0xFF;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_C))
            | (this.bc !== 0 ? FLAG_PV : 0)
            | (n & FLAG_X) | ((n & 0x02) ? FLAG_Y : 0);
        if (repeat && this.bc !== 0) { this.pc = (this.pc - 2) & 0xFFFF; this.tstates += 21; }
        else this.tstates += 16;
    }
    cpi(dir, repeat) {
        const v = this.read8(this.hl);
        const r = (this.a - v) & 0xFF;
        this.hl = (this.hl + dir) & 0xFFFF;
        this.bc = (this.bc - 1) & 0xFFFF;
        const h = ((this.a ^ v ^ r) & 0x10) ? FLAG_H : 0;
        const n = (r - (h ? 1 : 0)) & 0xFF;
        this.f = (this.f & FLAG_C) | FLAG_N | h
            | (r & 0x80 ? FLAG_S : 0) | (r === 0 ? FLAG_Z : 0)
            | (this.bc !== 0 ? FLAG_PV : 0)
            | (n & FLAG_X) | ((n & 0x02) ? FLAG_Y : 0);
        if (repeat && this.bc !== 0 && r !== 0) { this.pc = (this.pc - 2) & 0xFFFF; this.tstates += 21; }
        else this.tstates += 16;
    }
    ini(dir, repeat) {
        const v = this.ioIn(this.bc);
        this.write8(this.hl, v);
        this.hl = (this.hl + dir) & 0xFFFF;
        this.b = (this.b - 1) & 0xFF;
        this.f = SZ[this.b] | FLAG_N;
        if (repeat && this.b !== 0) { this.pc = (this.pc - 2) & 0xFFFF; this.tstates += 21; }
        else this.tstates += 16;
    }
    outi(dir, repeat) {
        const v = this.read8(this.hl);
        this.b = (this.b - 1) & 0xFF;
        this.ioOut(this.bc, v);
        this.hl = (this.hl + dir) & 0xFFFF;
        this.f = SZ[this.b] | FLAG_N;
        if (repeat && this.b !== 0) { this.pc = (this.pc - 2) & 0xFFFF; this.tstates += 21; }
        else this.tstates += 16;
    }
    /** Z180 OTIM/OTDM/OTIMR/OTDMR: OUT0 (C),(HL); HL+=dir; C+=dir; B-- */
    otim(dir, repeat) {
        const v = this.read8(this.hl);
        this.ioOut(this.c, v);   // port is C (internal I/O space)
        this.hl = (this.hl + dir) & 0xFFFF;
        this.c = (this.c + dir) & 0xFF;
        this.b = (this.b - 1) & 0xFF;
        this.f = SZ[this.b] | FLAG_N | (this.b === 0 ? FLAG_Z : 0);
        if (repeat && this.b !== 0) { this.pc = (this.pc - 2) & 0xFFFF; this.tstates += 14; }
        else this.tstates += 14;
    }

    undefinedOp(bytes) {
        if (this.onUndefined) {
            this.onUndefined(this.pc, bytes);
        }
        this.tstates += 4;
    }
}
