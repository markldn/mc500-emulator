/**
 * WD1772 floppy disk controller for the Roland MC-500.
 *
 * Disk geometry: 3.5" DD, 80 tracks x 2 sides x 9 sectors x 512 bytes
 * (737280-byte raw images, standard 720K layout:
 *  offset = ((track*2 + side)*9 + sector-1) * 512).
 *
 * DRQ is serviced by Z180 DMA channel 1 (I/O address 0xE3); INTRQ is
 * wired to the CPU's /INT2 input. The side select comes from an external
 * latch (gate array), set by the machine via setSide().
 */

const ST_BUSY = 0x01;
const ST_DRQ = 0x02;        // type II/III
const ST_INDEX = 0x02;      // type I
const ST_TRACK0 = 0x04;     // type I
const ST_LOSTDATA = 0x04;   // type II/III
const ST_CRCERR = 0x08;
const ST_RNF = 0x10;        // record not found
const ST_SEEKERR = 0x10;    // type I
const ST_SPINUP = 0x20;     // type I
const ST_RECTYPE = 0x20;    // type II read
const ST_WPROT = 0x40;
const ST_MOTORON = 0x80;

const SECTORS = 9, SIDES = 2, TRACKS = 80, SECSIZE = 512;

export class WD1772 {
    constructor() {
        this.reset();
        this.onIntr = null;   // callback(level) when INTRQ changes
        this.writeProtected = false;
    }

    reset() {
        this.status = 0;
        this.track = 0;
        this.sector = 1;
        this.data = 0;
        this.side = 0;
        this.disk = null;        // Uint8Array(737280) or null
        this.diskInserted = false;

        this.intrq = false;
        this.drq = false;

        this.buffer = null;      // active data buffer (read or write)
        this.bufPos = 0;
        this.writing = false;    // buffer is being filled for a write
        this.pendingCycles = 0;  // countdown to command phase change
        this.phase = 'idle';     // idle | seek | rdwait | rd | wrwait | wr | done
        this.command = 0;
        this.lastType1Status = ST_TRACK0 | ST_SPINUP | ST_MOTORON;
        this.rotSector = 1;      // crude rotational position for Read Address
    }

    insertDisk(data, writeProtected = false) {
        this.disk = data;
        this.diskInserted = true;
        this.writeProtected = writeProtected;
    }
    ejectDisk() { this.disk = null; this.diskInserted = false; }
    setSide(s) { this.side = s & 1; }

    setIntrq(level) {
        if (this.intrq !== level) {
            this.intrq = level;
            if (this.onIntr) this.onIntr(level);
        }
    }

    // ---------------- register interface ----------------
    readReg(r) {
        switch (r & 3) {
            case 0:
                this.setIntrq(false);
                return this.status;
            case 1: return this.track;
            case 2: return this.sector;
            case 3: return this.readData();
        }
    }

    writeReg(r, v) {
        v &= 0xFF;
        switch (r & 3) {
            case 0: this.writeCommand(v); break;
            case 1: this.track = v; break;
            case 2: this.sector = v; break;
            case 3:
                this.data = v;
                if (this.phase === 'wr' && this.drq) this.writeData(v);
                break;
        }
    }

    writeCommand(cmd) {
        this.setIntrq(false);
        if ((cmd & 0xF0) === 0xD0) {
            // Force interrupt
            const wasBusy = this.status & ST_BUSY;
            this.phase = 'idle';
            this.drq = false;
            this.buffer = null;
            if (wasBusy) this.status &= ~ST_BUSY;
            else this.status = this.type1Status();
            if (cmd & 0x08) this.setIntrq(true); // immediate interrupt variant
            return;
        }
        if (this.status & ST_BUSY) return; // ignore new commands while busy

        this.command = cmd;
        const type = cmd >> 4;
        if (type <= 0x07) {
            // Type I: restore/seek/step
            this.status = ST_BUSY | ST_MOTORON;
            this.phase = 'seek';
            this.pendingCycles = 600; // ~100us: fast but nonzero
        } else if ((cmd & 0xE0) === 0x80) {
            // Type II read sector (0x80/0x90 single, multiple not used)
            this.status = ST_BUSY | ST_MOTORON;
            this.phase = 'rdwait';
            this.pendingCycles = 800;
        } else if ((cmd & 0xE0) === 0xA0) {
            // Type II write sector
            this.status = ST_BUSY | ST_MOTORON;
            this.phase = 'wrwait';
            this.pendingCycles = 800;
        } else if ((cmd & 0xF0) === 0xC0) {
            // Type III read address
            this.status = ST_BUSY | ST_MOTORON;
            this.phase = 'rdwait';
            this.pendingCycles = 800;
        } else if ((cmd & 0xF0) === 0xE0) {
            // Type III read track — return raw-ish dummy
            this.status = ST_BUSY | ST_MOTORON;
            this.phase = 'rdwait';
            this.pendingCycles = 800;
        } else if ((cmd & 0xF0) === 0xF0) {
            // Type III write track (format) — swallow bytes
            this.status = ST_BUSY | ST_MOTORON;
            this.phase = 'wrwait';
            this.pendingCycles = 800;
        }
    }

    type1Status() {
        let s = ST_MOTORON | ST_SPINUP;
        if (this.track === 0) s |= ST_TRACK0;
        if (this.writeProtected) s |= ST_WPROT;
        if (!this.diskInserted) s |= ST_SEEKERR;
        return s;
    }

    sectorOffset(sec) {
        if (this.track >= TRACKS || sec < 1 || sec > SECTORS) return -1;
        return ((this.track * SIDES + this.side) * SECTORS + (sec - 1)) * SECSIZE;
    }

    // ---------------- data path ----------------
    readData() {
        if (this.phase === 'rd' && this.buffer) {
            this.data = this.buffer[this.bufPos++];
            if (this.bufPos >= this.buffer.length) {
                this.buffer = null;
                this.drq = false;
                this.status &= ~(ST_BUSY | ST_DRQ);
                this.phase = 'idle';
                this.setIntrq(true);
            }
        }
        return this.data;
    }

    writeData(v) {
        if (this.phase === 'wr' && this.buffer) {
            this.buffer[this.bufPos++] = v;
            if (this.bufPos >= this.buffer.length) {
                this.flushWrite();
                this.buffer = null;
                this.drq = false;
                this.status &= ~(ST_BUSY | ST_DRQ);
                this.phase = 'idle';
                this.setIntrq(true);
            }
        }
    }

    flushWrite() {
        if ((this.command & 0xF0) === 0xF0) return; // write track: discard
        const off = this.sectorOffset(this.sector);
        if (off >= 0 && this.disk) {
            this.disk.set(this.buffer, off);
            if (this.onDiskWrite) this.onDiskWrite();
        }
    }

    // ---------------- timing ----------------
    tick(cycles) {
        if (this.phase === 'idle' || this.phase === 'rd' || this.phase === 'wr') return;
        this.pendingCycles -= cycles;
        if (this.pendingCycles > 0) return;

        if (this.phase === 'seek') {
            const cmd = this.command;
            const type = cmd >> 4;
            if (type === 0) {
                this.track = 0;                    // Restore
            } else if (type === 1) {
                this.track = this.data;            // Seek to data register
            } else {
                // Step / step-in / step-out
                const dirIn = (type === 4 || type === 5) ? 1 :
                              (type === 6 || type === 7) ? -1 :
                              (this.lastStepDir || 1);
                this.lastStepDir = dirIn;
                if (cmd & 0x10 || type >= 4) {     // update track reg
                    this.track = Math.max(0, Math.min(255, this.track + dirIn));
                }
            }
            this.phase = 'idle';
            this.status = this.type1Status();
            // Verify bit: if set and track unreadable, set seek error
            if ((this.command & 0x04) && !this.diskInserted) this.status |= ST_SEEKERR;
            this.setIntrq(true);
            return;
        }

        if (this.phase === 'rdwait') {
            const cmd = this.command;
            if (!this.diskInserted || !this.disk) {
                this.finishError(ST_RNF);
                return;
            }
            if ((cmd & 0xE0) === 0x80) {           // read sector
                const off = this.sectorOffset(this.sector);
                if (off < 0) { this.finishError(ST_RNF); return; }
                this.buffer = this.disk.subarray(off, off + SECSIZE);
                this.bufPos = 0;
                this.phase = 'rd';
                this.drq = true;
                this.status |= ST_DRQ;
            } else if ((cmd & 0xF0) === 0xC0) {    // read address
                this.rotSector = (this.rotSector % SECTORS) + 1;
                this.buffer = Uint8Array.from([
                    this.track, this.side, this.rotSector, 2, 0xCA, 0xFE,
                ]);
                this.bufPos = 0;
                this.phase = 'rd';
                this.drq = true;
                this.status |= ST_DRQ;
                // WD177x also copies the track address into the sector register
                this.sector = this.track;
            } else {                               // read track
                this.buffer = new Uint8Array(6250).fill(0x4E);
                this.bufPos = 0;
                this.phase = 'rd';
                this.drq = true;
                this.status |= ST_DRQ;
            }
            return;
        }

        if (this.phase === 'wrwait') {
            if (!this.diskInserted || !this.disk) {
                this.finishError(ST_RNF);
                return;
            }
            if (this.writeProtected) {
                this.finishError(ST_WPROT);
                return;
            }
            if ((this.command & 0xF0) === 0xF0) {
                this.buffer = new Uint8Array(6250); // write track: swallow
            } else {
                const off = this.sectorOffset(this.sector);
                if (off < 0) { this.finishError(ST_RNF); return; }
                this.buffer = new Uint8Array(SECSIZE);
            }
            this.bufPos = 0;
            this.phase = 'wr';
            this.drq = true;
            this.status |= ST_DRQ;
            return;
        }
    }

    finishError(bits) {
        this.phase = 'idle';
        this.drq = false;
        this.buffer = null;
        this.status = (this.status & ~(ST_BUSY | ST_DRQ)) | bits | ST_MOTORON;
        this.setIntrq(true);
    }
}
