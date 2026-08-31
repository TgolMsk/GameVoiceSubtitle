/**
 * 48kHz / 16bit / stereo → 16kHz / 16bit / mono.
 *
 * Strategy (kept deliberately simple, per spec):
 *  1. mix stereo to mono by averaging L/R
 *  2. decimate 3:1 (48000/16000), taking the average of each group of 3 mono
 *     samples as a cheap low-pass to reduce aliasing
 *
 * Output is re-framed into fixed 20ms frames: 320 samples / 640 bytes @16kHz.
 */

export const FRAME_SAMPLES = 320; // 20ms @ 16kHz
export const FRAME_BYTES = FRAME_SAMPLES * 2;

const GROUP_BYTES = 12; // 3 stereo int16 pairs → 1 output sample

export class Resampler {
  /** Byte-level carry-over — chunk boundaries may split an int16 or a stereo pair. */
  private inputRemainder: Buffer = Buffer.alloc(0);
  /** Carry-over of output samples that didn't fill a full 20ms frame. */
  private outputPending: Int16Array = new Int16Array(FRAME_SAMPLES);
  private outputPendingLen = 0;

  /**
   * Feed raw 48k stereo PCM. Returns zero or more complete 20ms 16k mono frames.
   */
  process(chunk: Buffer): Int16Array[] {
    const buf = this.inputRemainder.length > 0 ? Buffer.concat([this.inputRemainder, chunk]) : chunk;
    const usableBytes = buf.length - (buf.length % GROUP_BYTES);

    // An Int16Array view requires 2-byte alignment; Buffer.concat allocations are
    // aligned, but a raw chunk sliced from a pool may not be — copy in that case.
    const aligned = buf.byteOffset % 2 === 0 ? buf : Buffer.from(buf.subarray(0, usableBytes));
    const input = new Int16Array(aligned.buffer, aligned.byteOffset, usableBytes / 2);

    const groups = usableBytes / GROUP_BYTES;
    const frames: Int16Array[] = [];

    for (let g = 0; g < groups; g++) {
      const base = g * 6;
      // Average of 3 mono samples, each mono sample the average of L and R.
      const mono0 = (input[base] + input[base + 1]) / 2;
      const mono1 = (input[base + 2] + input[base + 3]) / 2;
      const mono2 = (input[base + 4] + input[base + 5]) / 2;
      let sample = Math.round((mono0 + mono1 + mono2) / 3);
      if (sample > 32767) sample = 32767;
      else if (sample < -32768) sample = -32768;

      this.outputPending[this.outputPendingLen++] = sample;
      if (this.outputPendingLen === FRAME_SAMPLES) {
        frames.push(this.outputPending.slice());
        this.outputPendingLen = 0;
      }
    }

    // Copy the tail — `buf` may reference the native callback's reusable memory.
    this.inputRemainder = Buffer.from(buf.subarray(usableBytes));
    return frames;
  }

  reset(): void {
    this.inputRemainder = Buffer.alloc(0);
    this.outputPendingLen = 0;
  }
}

/** RMS level of a frame, normalized to 0..1 — used for the overlay volume meter. */
export function frameRms(frame: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

/** Serializes an int16 frame into a little-endian PCM Buffer (for WebSocket upload). */
export function frameToBuffer(frame: Int16Array): Buffer {
  return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
}
