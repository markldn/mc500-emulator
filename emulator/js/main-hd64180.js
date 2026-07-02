/**
 * Roland MC-500 Emulator - Web UI entry point.
 *
 * Uses the working rewritten core: Z180 CPU + MC500 machine model + WD1772 FDC.
 */

import { MC500, CPU_HZ } from './mc500.js';

/**
 * Key matrix positions [port, bit] as decoded by the MRC-500 OS
 * (verified against firmware behavior; ports 0xC0-0xC3, active low).
 */
const KEY_MATRIX = {
    '0': [0, 0], '1': [0, 1], '2': [0, 2], '3': [0, 3], '4': [0, 4],
    '5': [0, 5], '6': [0, 6], '7': [0, 7], '8': [1, 0], '9': [1, 1],
    'skip':   [1, 2],
    'cancel': [1, 3],   // MkII only; exits prompts under MRC-500 too
    'left':   [1, 4],   // TIE
    'right':  [1, 5],   // REST
    'enter':  [1, 6],
    'shift':  [1, 7],
    'track1': [2, 0], 'track2': [2, 1], 'track3': [2, 2], 'track4': [2, 3],
    'rhythm': [2, 4],
    'edit':   [2, 5],
    'mode':   [2, 6],   // LOC/MODE on MkII
    'loc':    [2, 6],
    'func':   [2, 7],
    'midi':   [3, 0],
    'avail':  [3, 1],   // AVAIL MEMO (MkI)
    'micro':  [3, 2],   // MICROSCOPE / MICRO EDIT
    'reset':  [3, 3],
    'play':   [3, 4],
    'stop':   [3, 5],
    'pause':  [3, 6],
    'rec':    [3, 7],
};

// Panel LED latch bits (active low)
const LED_BITS = { rec: 0, play: 1, pause: 2, track1: 3, track2: 4, track3: 5, track4: 6, rhythm: 7 };

/** Assembles a raw MIDI byte stream into complete messages for Web MIDI send(). */
class MidiOutAssembler {
    constructor(send) {
        this.send = send;
        this.buf = [];
        this.expected = 0;
        this.inSysex = false;
    }
    static dataLength(status) {
        if (status < 0xF0) return ((status & 0xE0) === 0xC0) ? 1 : 2; // Cn/Dn take 1
        return { 0xF1: 1, 0xF2: 2, 0xF3: 1 }[status] ?? 0;
    }
    push(byte) {
        if (byte >= 0xF8) { this.send([byte]); return; }          // realtime
        if (this.inSysex) {
            this.buf.push(byte);
            if (byte === 0xF7) { this.send(this.buf); this.buf = []; this.inSysex = false; }
            return;
        }
        if (byte & 0x80) {
            if (byte === 0xF0) { this.inSysex = true; this.buf = [0xF0]; return; }
            this.buf = [byte];
            this.expected = MidiOutAssembler.dataLength(byte);
            if (this.expected === 0) { this.send(this.buf); this.buf = []; }
        } else if (this.buf.length) {
            this.buf.push(byte);
            if (this.buf.length - 1 >= this.expected) {
                this.send(this.buf);
                this.buf = [this.buf[0]];                         // running status
            }
        }
    }
}

class EmulatorUI {
    constructor() {
        this.mc = new MC500();

        this.ui = {
            cpuStatus: document.getElementById('cpu-status'),
            pcValue: document.getElementById('pc-value'),
            cycleCount: document.getElementById('cycle-count'),
            fdcStatus: document.getElementById('fdc-status'),
            debugLog: document.getElementById('debug-log'),
            lcdLine1: document.querySelectorAll('.lcd-line-1'),
            lcdLine2: document.querySelectorAll('.lcd-line-2'),
        };

        this.running = false;
        this.frameId = null;
        this.lastLCD = ['', ''];
        this.lastLeds = -1;

        // MIDI OUT: two ports (ASCI0 = OUT1, ASCI1 = OUT2)
        this.midiAccess = null;
        this.midiOutPorts = [null, null];
        this.midiOutAsm = [
            new MidiOutAssembler((msg) => this.midiSend(0, msg)),
            new MidiOutAssembler((msg) => this.midiSend(1, msg)),
        ];
        this.midiCounts = { in: 0, out: 0 };
        this.mc.onMidiOut = (ch, byte) => {
            this.midiCounts.out++;
            this.midiOutAsm[ch === 1 ? 1 : 0].push(byte);
        };

        // Track firmware writes to the floppy image (Mode 2 SAVE etc.)
        this.diskDirty = false;
        this.mc.fdc.onDiskWrite = () => { this.diskDirty = true; };

        this.setupUIHandlers();
        this.setupTheme();
        this.setupDisk();
        this.initMidi();
        this.autoLoad();
    }

    // ---- UI wiring ----

    setupUIHandlers() {
        document.getElementById('btn-load')?.addEventListener('click', () => this.loadFiles());
        document.getElementById('btn-start')?.addEventListener('click', () => this.start());
        document.getElementById('btn-stop')?.addEventListener('click', () => this.stop());
        document.getElementById('btn-reset')?.addEventListener('click', () => this.reset());

        // Front panel buttons (both themes share data-key handlers)
        document.querySelectorAll('.panel-btn[data-key]').forEach(btn => {
            const key = btn.dataset.key;
            btn.addEventListener('mousedown', (e) => { e.preventDefault(); this.pressKey(key); btn.classList.add('active'); });
            btn.addEventListener('mouseup', () => { this.releaseKey(key); btn.classList.remove('active'); });
            btn.addEventListener('mouseleave', () => { this.releaseKey(key); btn.classList.remove('active'); });
            btn.addEventListener('touchstart', (e) => { e.preventDefault(); this.pressKey(key); btn.classList.add('active'); });
            btn.addEventListener('touchend', () => { this.releaseKey(key); btn.classList.remove('active'); });
        });

        // Alpha dial: wheel and vertical drag turn it; knob rotates for feedback
        this.dialAngle = 0;
        document.querySelectorAll('.alpha-dial').forEach(dial => {
            const knob = dial.querySelector('.dial-inner');
            const turn = (steps) => {
                if (!steps) return;
                this.mc.dial(steps);
                this.dialAngle += steps * 18;
                document.querySelectorAll('.dial-inner').forEach(k =>
                    k.style.transform = `rotate(${this.dialAngle}deg)`);
            };
            dial.addEventListener('wheel', (e) => {
                e.preventDefault();
                turn(e.deltaY < 0 ? 1 : -1);
            });
            let dragging = false, lastY = 0, acc = 0;
            dial.addEventListener('mousedown', (e) => { e.preventDefault(); dragging = true; lastY = e.clientY; acc = 0; });
            document.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                acc += (lastY - e.clientY) / 8;   // up = clockwise = +
                lastY = e.clientY;
                const s = Math.trunc(acc);
                if (s) { acc -= s; turn(s); }
            });
            document.addEventListener('mouseup', () => { dragging = false; });
            void knob;
        });

        // Keyboard shortcuts
        const keymap = {
            'Enter': 'enter', 'Escape': 'stop', ' ': 'play', 'Backspace': 'reset',
            'ArrowLeft': 'left', 'ArrowRight': 'right',
            '0': '0', '1': '1', '2': '2', '3': '3', '4': '4',
            '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
        };
        document.addEventListener('keydown', (e) => {
            if (e.repeat) return;
            if (e.key === 'ArrowUp') { e.preventDefault(); this.mc.dial(1); return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); this.mc.dial(-1); return; }
            const k = keymap[e.key];
            if (k) { e.preventDefault(); this.pressKey(k); }
        });
        document.addEventListener('keyup', (e) => {
            const k = keymap[e.key];
            if (k) this.releaseKey(k);
        });
    }

    pressKey(key) {
        const m = KEY_MATRIX[key];
        if (m) this.mc.keys.press(m[0], m[1]);
    }
    releaseKey(key) {
        const m = KEY_MATRIX[key];
        if (m) this.mc.keys.release(m[0], m[1]);
    }

    // ---- Theme ----

    setupTheme() {
        const sel = document.getElementById('theme-select');
        const mk1 = document.getElementById('panel-mk1');
        const mk2 = document.getElementById('panel-mk2');
        if (!mk1 || !mk2) {
            // stale cached index.html without the theme panels
            this.log('error', 'Page is outdated — hard-refresh (Cmd+Shift+R)');
            return;
        }
        const apply = (theme) => {
            mk1.hidden = theme !== 'mk1';
            mk2.hidden = theme !== 'mk2';
            localStorage.setItem('mc500-theme', theme);
        };
        const saved = localStorage.getItem('mc500-theme') || 'mk1';
        if (sel) {
            sel.value = saved;
            sel.addEventListener('change', () => apply(sel.value));
        }
        apply(saved);
        // theme switch invalidates cached LCD/LED state
        this.lastLCD = ['', ''];
        this.lastLeds = -1;
    }

    // ---- Disk download / upload ----

    setupDisk() {
        document.getElementById('btn-disk-download')?.addEventListener('click', () => {
            const data = this.mc.fdc.disk;
            if (!data) { this.log('warn', 'No disk inserted'); return; }
            const blob = new Blob([data], { type: 'application/octet-stream' });
            const a = document.createElement('a');
            const ts = new Date().toISOString().slice(0, 16).replace('T', '_').replaceAll(':', '');
            a.href = URL.createObjectURL(blob);
            a.download = `mc500_${ts}.dsk`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            this.diskDirty = false;
            this.log('info', `Disk image downloaded (${a.download})`);
        });

        const fileInput = document.getElementById('disk-file');
        document.getElementById('btn-disk-insert')?.addEventListener('click', () => fileInput?.click());
        fileInput?.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            fileInput.value = '';
            if (!file) return;
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (bytes.length !== 737280) {
                this.log('error', `${file.name}: expected a 737280-byte 720K image, got ${bytes.length} bytes`);
                return;
            }
            this.mc.insertDisk(bytes);
            this.diskDirty = false;
            this.log('info', `Inserted ${file.name} — use MODE 2 to load songs from it`);
        });

        // Don't lose an unsaved disk image on accidental close/refresh
        window.addEventListener('beforeunload', (e) => {
            if (this.diskDirty) { e.preventDefault(); e.returnValue = ''; }
        });
    }

    // ---- Web MIDI ----

    async initMidi() {
        if (!navigator.requestMIDIAccess) {
            this.log('warn', 'Web MIDI not supported in this browser');
            return;
        }
        try {
            try { this.midiAccess = await navigator.requestMIDIAccess({ sysex: true }); }
            catch { this.midiAccess = await navigator.requestMIDIAccess(); }
        } catch (err) {
            this.log('warn', 'MIDI access denied: ' + err.message);
            return;
        }
        this.log('info', 'Web MIDI ready');
        this.populateMidiSelects();
        this.midiAccess.addEventListener('statechange', () => this.populateMidiSelects());

        document.getElementById('midi-in')?.addEventListener('change', () => this.bindMidiIn());
        document.getElementById('midi-out1')?.addEventListener('change', () => this.bindMidiOut(0));
        document.getElementById('midi-out2')?.addEventListener('change', () => this.bindMidiOut(1));
    }

    populateMidiSelects() {
        const fill = (id, ports) => {
            const sel = document.getElementById(id);
            if (!sel) return;
            const prev = sel.value;
            sel.innerHTML = '<option value="">(none)</option>';
            for (const p of ports.values()) {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.name;
                sel.appendChild(opt);
            }
            sel.value = prev;
            if (sel.value !== prev) sel.value = '';
        };
        fill('midi-in', this.midiAccess.inputs);
        fill('midi-out1', this.midiAccess.outputs);
        fill('midi-out2', this.midiAccess.outputs);
        this.bindMidiIn();
        this.bindMidiOut(0);
        this.bindMidiOut(1);
    }

    bindMidiIn() {
        const id = document.getElementById('midi-in')?.value;
        for (const input of this.midiAccess.inputs.values()) {
            input.onmidimessage = null;
        }
        if (!id) return;
        const input = this.midiAccess.inputs.get(id);
        if (input) {
            input.onmidimessage = (e) => {
                this.midiCounts.in += e.data.length;
                this.mc.midiIn(e.data);
            };
            this.log('info', `MIDI IN <- ${input.name}`);
        }
    }

    bindMidiOut(ch) {
        const id = document.getElementById(ch === 0 ? 'midi-out1' : 'midi-out2')?.value;
        this.midiOutPorts[ch] = id ? this.midiAccess.outputs.get(id) || null : null;
        if (this.midiOutPorts[ch]) this.log('info', `MIDI OUT${ch + 1} -> ${this.midiOutPorts[ch].name}`);
    }

    midiSend(ch, msg) {
        const port = this.midiOutPorts[ch];
        if (!port) return;
        try { port.send(msg); } catch (e) { /* e.g. sysex without permission */ }
    }

    // ---- File loading ----

    async loadFiles() {
        if (this.diskDirty && !confirm('The disk image has unsaved changes. Discard them?')) return;
        this.diskDirty = false;
        const romFile = document.getElementById('rom-select').value;
        const diskFile = document.getElementById('disk-select').value;

        try {
            const romResp = await fetch(`roms/${romFile}`);
            if (!romResp.ok) throw new Error(`ROM ${romFile} not found (${romResp.status})`);
            this.mc.loadROM(new Uint8Array(await romResp.arrayBuffer()));

            const diskResp = await fetch(`disks/${diskFile}`);
            if (!diskResp.ok) throw new Error(`Disk ${diskFile} not found (${diskResp.status})`);
            this.mc.insertDisk(new Uint8Array(await diskResp.arrayBuffer()));

            this.log('info', `Loaded ${romFile} + ${diskFile}`);
            document.getElementById('btn-start').disabled = false;
            document.getElementById('btn-reset').disabled = false;
            this.ui.cpuStatus.textContent = 'Ready';
            this.reset();
            this.start();
        } catch (err) {
            this.log('error', err.message);
            this.ui.cpuStatus.textContent = 'Load failed';
        }
    }

    async autoLoad() {
        const romSelect = document.getElementById('rom-select');
        const diskSelect = document.getElementById('disk-select');
        if (!romSelect.value) romSelect.value = 'MC-500-v2.2.bin';
        if (!diskSelect.value) diskSelect.value = 'MRC-500-v110.dsk';
        await this.loadFiles();
    }

    // ---- Control ----

    reset() {
        this.stop();
        this.mc.reset();
        this.log('info', 'System reset');
        this.updateUI();
    }

    start() {
        if (this.running) return;
        this.running = true;
        document.getElementById('btn-start').disabled = true;
        document.getElementById('btn-stop').disabled = false;
        this.ui.cpuStatus.textContent = 'Running';
        this.log('info', 'Emulation started');
        this.loop();
    }

    stop() {
        this.running = false;
        if (this.frameId) { cancelAnimationFrame(this.frameId); this.frameId = null; }
        document.getElementById('btn-start').disabled = false;
        document.getElementById('btn-stop').disabled = true;
        this.ui.cpuStatus.textContent = 'Stopped';
    }

    loop() {
        if (!this.running) return;
        // ~6M cycles per frame at 60fps
        this.mc.run(CPU_HZ / 60);
        this.updateUI();
        this.frameId = requestAnimationFrame(() => this.loop());
    }

    // ---- UI update ----

    updateUI() {
        const cpu = this.mc.cpu;
        this.ui.pcValue.textContent = cpu.pc.toString(16).toUpperCase().padStart(4, '0');
        this.ui.cycleCount.textContent = cpu.tstates.toLocaleString();

        const fdc = this.mc.fdc;
        this.ui.fdcStatus.textContent = fdc.phase === 'idle' ? 'Ready' : fdc.phase;

        const midiStatus = document.getElementById('midi-status');
        if (midiStatus) midiStatus.textContent = `in ${this.midiCounts.in} / out ${this.midiCounts.out}`;

        const diskStatus = document.getElementById('disk-status');
        if (diskStatus) {
            diskStatus.textContent = this.diskDirty ? 'modified — download to keep' : 'unchanged';
            diskStatus.style.color = this.diskDirty ? '#ffaa00' : '';
        }

        const lines = this.mc.lcd.getLines();
        if (lines[0] !== this.lastLCD[0]) {
            this.ui.lcdLine1.forEach(el => el.textContent = lines[0]);
            this.lastLCD[0] = lines[0];
        }
        if (lines[1] !== this.lastLCD[1]) {
            this.ui.lcdLine2.forEach(el => el.textContent = lines[1]);
            this.lastLCD[1] = lines[1];
        }

        // Panel LEDs (latch is active low)
        if (this.mc.leds !== this.lastLeds) {
            this.lastLeds = this.mc.leds;
            for (const [name, bit] of Object.entries(LED_BITS)) {
                const on = !(this.mc.leds & (1 << bit));
                document.querySelectorAll(`.led-${name}`).forEach(el =>
                    el.classList.toggle('led-on', on));
            }
        }
    }

    log(level, msg) {
        const ts = new Date().toLocaleTimeString();
        const div = document.createElement('div');
        div.className = level;
        div.textContent = `[${ts}] ${msg}`;
        if (this.ui.debugLog) {
            this.ui.debugLog.appendChild(div);
            this.ui.debugLog.scrollTop = this.ui.debugLog.scrollHeight;
            while (this.ui.debugLog.children.length > 100) this.ui.debugLog.removeChild(this.ui.debugLog.firstChild);
        }
        console.log(`[${level}] ${msg}`);
    }
}

// Init
document.addEventListener('DOMContentLoaded', () => {
    const li = document.getElementById('loading-indicator');
    if (li) li.style.display = 'none';
    const emu = new EmulatorUI();
    window.mc500 = emu.mc;
    window.mc500ui = emu;
    console.log('%cRoland MC-500 Emulator loaded', 'color: #0af; font-weight: bold');
});

export { EmulatorUI };
