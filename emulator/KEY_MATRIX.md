# MC-500 Panel Key Matrix (verified against MRC-500 v1.10 firmware)

Panel switches are read at I/O ports 0xC0-0xC3 (active low, one bit per key).
Positions below are `port:bit`. All were verified behaviorally by driving the
firmware in the console harness (see git-less history: key-probe*.mjs).

| Pos | Key          | Pos | Key            | Pos | Key           | Pos | Key        |
|-----|--------------|-----|----------------|-----|---------------|-----|------------|
| 0:0 | 0            | 1:0 | 8              | 2:0 | TRACK 1       | 3:0 | MIDI       |
| 0:1 | 1            | 1:1 | 9              | 2:1 | TRACK 2       | 3:1 | AVAIL MEMO |
| 0:2 | 2            | 1:2 | SKIP           | 2:2 | TRACK 3       | 3:2 | MICROSCOPE |
| 0:3 | 3            | 1:3 | CANCEL (MkII)  | 2:3 | TRACK 4       | 3:3 | RESET      |
| 0:4 | 4            | 1:4 | ◀ (TIE)        | 2:4 | RHYTHM        | 3:4 | PLAY/SAVE  |
| 0:5 | 5            | 1:5 | ▶ (REST)       | 2:5 | EDIT          | 3:5 | STOP       |
| 0:6 | 6            | 1:6 | ENTER          | 2:6 | MODE          | 3:6 | PAUSE      |
| 0:7 | 7            | 1:7 | SHIFT          | 2:7 | FUNC          | 3:7 | REC/LOAD   |

Notes:
- 1:3 behaves as a prompt-exit key under MRC-500 v1.10; it is the MkII CANCEL
  position (the MkI panel has no key there).
- Evidence highlights: ENTER confirmed via TIME SIGN prompt + "Press PLAY
  Button!" record flow; SHIFT via SHIFT+PLAY block-repeat; AVAIL MEMO shows
  "AVAIL ON MEMORY ▶ nn%" (needs HD44780 display-shift emulation); PAUSE
  freezes playback instantly; STOP stops at end of bar.

## LED latch

Writes to port 0xC0 drive the panel LEDs, active low:

| bit | LED    | bit | LED     |
|-----|--------|-----|---------|
| 0   | REC    | 4   | TRACK 2 |
| 1   | PLAY   | 5   | TRACK 3 |
| 2   | PAUSE  | 6   | TRACK 4 |
| 3   | TRACK1 | 7   | RHYTHM  |

(REC flashes in record-standby; RHYTHM + recorded tracks light after
recording — matches the owner's manual.)

## Alpha dial

The dial is not in the key matrix. It drives two lines read at port 0xB0:
bit 7 = up, bit 6 = down. The OS debounces ~10ms, then counts one step per
~16.7ms the line stays asserted; separate pulses in quick succession get
firmware acceleration (double counts), like turning the real dial fast.
`MC500.dial(delta)` converts steps into correctly-timed line assertions.

## Record flow (for testing)

REC(3:7) → ENTER(1:6) ×2 (accept 4/4) → "Press PLAY Button!" → PLAY(3:4)
→ 2-bar count-in ("MEAS- 8…-1") → recording; MIDI IN notes are recorded;
STOP(3:5) ends at bar end. `browser-test.mjs` exercises the web UI.
