// audio-ring.js: single producer, single consumer stereo sample ring.
// GPL-2.0-or-later.
//
// The core (main thread or a worker) pushes libretro audio: interleaved
// signed 16 bit stereo frames from retro_audio_sample_batch. The
// AudioWorklet pulls float frames on the audio thread. Backed by a
// SharedArrayBuffer when the page is cross-origin isolated, else by a
// plain ArrayBuffer (then producer and consumer must share a thread, which
// is only useful for tests).
//
// Layout: Int32 header [readIndex, writeIndex, pushed, nonZero, dropped,
// batches] then Int16 data, capacity frames x 2 channels. Indices count
// frames and wrap at capacity * 2 so full and empty can be told apart.
//
// The four counters are the producer's, for diagnostics only (counters()):
// frames written, frames written that were not silence, frames that did not
// fit, and push calls. They live in the shared header so the page can read
// what a board in a worker is making without a message; each wraps at 2^32
// (about 27 hours of frames at 44100 Hz), so a reader takes differences
// with (b - a) >>> 0. They cost one compare per frame in a loop that already
// visits every frame, and never block.

const HEADER_INTS = 6;
const READ = 0;
const WRITE = 1;
const PUSHED = 2;
const NONZERO = 3;
const DROPPED = 4;
const BATCHES = 5;

export function ringByteLength(capacityFrames) {
  return HEADER_INTS * 4 + capacityFrames * 2 * 2;
}

export function allocateRingBuffer(capacityFrames) {
  if (!Number.isInteger(capacityFrames) || capacityFrames < 2) {
    throw new Error('capacity must be an integer >= 2');
  }
  const len = ringByteLength(capacityFrames);
  return typeof SharedArrayBuffer === 'function'
    ? new SharedArrayBuffer(len)
    : new ArrayBuffer(len);
}

export class AudioRing {
  constructor(buffer, capacityFrames) {
    if (buffer.byteLength !== ringByteLength(capacityFrames)) {
      throw new Error('buffer size does not match capacity');
    }
    this.capacity = capacityFrames;
    this.header = new Int32Array(buffer, 0, HEADER_INTS);
    this.data = new Int16Array(buffer, HEADER_INTS * 4, capacityFrames * 2);
    this.shared = typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer;
    this.dropped = 0;
    this.underruns = 0;
  }

  load(i) { return this.shared ? Atomics.load(this.header, i) : this.header[i]; }
  store(i, v) { if (this.shared) Atomics.store(this.header, i, v); else this.header[i] = v; }
  // Producer only (one writer): a counter moves on by n, wrapping.
  count(i, n) { if (n) this.store(i, (this.load(i) + n) | 0); }

  // What the producer has done since the ring was made, whichever thread
  // asks: { pushed, nonZero, dropped, batches } (see the layout note).
  counters() {
    return { pushed: this.load(PUSHED) >>> 0, nonZero: this.load(NONZERO) >>> 0, dropped: this.load(DROPPED) >>> 0, batches: this.load(BATCHES) >>> 0 };
  }

  available() {
    const w = this.load(WRITE);
    const r = this.load(READ);
    return (w - r + 2 * this.capacity) % (2 * this.capacity);
  }

  free() { return this.capacity - this.available(); }

  // samples: Int16Array, interleaved L R. Returns frames written; frames
  // that do not fit are dropped (counted in .dropped) so the core never
  // blocks on audio.
  push(samples, frames = samples.length >> 1) {
    const n = Math.min(frames, this.free());
    let w = this.load(WRITE);
    let nz = 0;
    for (let f = 0; f < n; f++) {
      const slot = (w % this.capacity) * 2;
      const l = samples[f * 2];
      const r = samples[f * 2 + 1];
      this.data[slot] = l;
      this.data[slot + 1] = r;
      if (l !== 0 || r !== 0) nz++;
      w = (w + 1) % (2 * this.capacity);
    }
    this.store(WRITE, w);
    this.dropped += frames - n;
    this.count(PUSHED, n);
    this.count(NONZERO, nz);
    this.count(DROPPED, frames - n);
    this.count(BATCHES, 1);
    return n;
  }

  // Consumer only: drops up to frames of the oldest unplayed audio. Returns
  // frames dropped.
  skip(frames) {
    const n = Math.max(0, Math.min(Math.floor(frames), this.available()));
    this.store(READ, (this.load(READ) + n) % (2 * this.capacity));
    return n;
  }

  // Consumer only: up to count frames into left and right from index
  // offset, as floats, with no allocation. No underrun is counted (the
  // caller asks only for what is there). Returns frames read.
  pullInto(left, right, offset, count) {
    const n = Math.max(0, Math.min(count, this.available(), left.length - offset));
    let r = this.load(READ);
    for (let f = 0; f < n; f++) {
      const slot = (r % this.capacity) * 2;
      left[offset + f] = this.data[slot] / 32768;
      right[offset + f] = this.data[slot + 1] / 32768;
      r = (r + 1) % (2 * this.capacity);
    }
    this.store(READ, r);
    return n;
  }

  // Fills two Float32Arrays (one per channel). Missing frames are silence
  // and counted in .underruns (once per short pull). Returns frames read.
  pull(left, right) {
    const want = left.length;
    const n = Math.min(want, this.available());
    let r = this.load(READ);
    for (let f = 0; f < n; f++) {
      const slot = (r % this.capacity) * 2;
      left[f] = this.data[slot] / 32768;
      right[f] = this.data[slot + 1] / 32768;
      r = (r + 1) % (2 * this.capacity);
    }
    this.store(READ, r);
    if (n < want) {
      left.fill(0, n);
      right.fill(0, n);
      this.underruns++;
    }
    return n;
  }
}
