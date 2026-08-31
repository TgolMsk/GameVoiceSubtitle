import * as path from 'path';
import { app } from 'electron';
import * as ort from 'onnxruntime-node';
import { logger } from '../logger';
import { FRAME_SAMPLES } from './resampler';

/**
 * Silero VAD gate.
 *
 * Consumes 20ms / 320-sample frames @16kHz, runs Silero on 512-sample windows,
 * and drives the IDLE/SPEAKING state machine:
 *   IDLE     --3 consecutive windows above enter threshold--> SPEAKING (emits 300ms pre-roll)
 *   SPEAKING --500ms below exit threshold-----------------> IDLE (segmentEnd)
 *   SPEAKING --30s elapsed--------------------------------> force segment cut (end + restart)
 *
 * Only SPEAKING audio reaches the ASR client — this is what keeps the API bill down.
 */

const WINDOW_SAMPLES = 512;
const WINDOW_MS = (WINDOW_SAMPLES / 16000) * 1000; // 32ms
const PREROLL_MS = 300;
const PREROLL_FRAMES = Math.ceil(PREROLL_MS / 20); // 15 frames
const ENTER_WINDOWS = 3;
const EXIT_WINDOWS = Math.ceil(500 / WINDOW_MS); // ~16 windows = 500ms
const MAX_SEGMENT_MS = 30_000;

export interface VadEvents {
  /** New speech segment begins; `preroll` contains up to 300ms of audio before the trigger. */
  onSegmentStart(preroll: Int16Array[]): void;
  /** A 20ms frame inside an active segment. */
  onSpeechFrame(frame: Int16Array): void;
  onSegmentEnd(): void;
  onSpeakingChange(speaking: boolean): void;
}

export class VadGate {
  private session: ort.InferenceSession | null = null;
  /** Silero v5 keeps a single [2,1,128] recurrent state; v4 uses h/c [2,1,64] each. */
  private state: ort.Tensor | null = null;
  private stateH: ort.Tensor | null = null;
  private stateC: ort.Tensor | null = null;
  private isV5 = false;

  private windowBuf = new Float32Array(WINDOW_SAMPLES);
  private windowLen = 0;
  private inferring = false;

  private speaking = false;
  private aboveCount = 0;
  private belowCount = 0;
  private segmentStartedAt = 0;
  private preroll: Int16Array[] = [];

  private enterThreshold = 0.5;
  private exitThreshold = 0.35;

  constructor(private events: VadEvents) {}

  /** sensitivity 0..1; higher = triggers more easily. 0.5 maps to the spec defaults. */
  setSensitivity(sensitivity: number): void {
    const s = Math.min(1, Math.max(0, sensitivity));
    this.enterThreshold = 0.75 - 0.5 * s; // 0.5 -> 0.5
    this.exitThreshold = this.enterThreshold * 0.7; // 0.5 -> 0.35
  }

  async init(): Promise<void> {
    const modelPath = app.isPackaged
      ? path.join(process.resourcesPath, 'resources', 'silero_vad.onnx')
      : path.join(app.getAppPath(), 'resources', 'silero_vad.onnx');
    this.session = await ort.InferenceSession.create(modelPath, {
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
    });
    this.isV5 = this.session.inputNames.includes('state');
    this.resetModelState();
    logger.info(`Silero VAD loaded (${this.isV5 ? 'v5' : 'v4'} interface)`);
  }

  private resetModelState(): void {
    if (this.isV5) {
      this.state = new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
    } else {
      this.stateH = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
      this.stateC = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
    }
  }

  /** Feed one 20ms frame. Inference runs asynchronously; frames are never blocked on it. */
  pushFrame(frame: Int16Array): void {
    if (!this.session) return;

    // Maintain pre-roll ring buffer while idle.
    if (!this.speaking) {
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
    } else {
      this.events.onSpeechFrame(frame);
      if (Date.now() - this.segmentStartedAt >= MAX_SEGMENT_MS) {
        // Force cut: close the segment but stay in SPEAKING with a fresh one,
        // so long monologues are split without dropping audio.
        this.events.onSegmentEnd();
        this.events.onSegmentStart([]);
        this.segmentStartedAt = Date.now();
      }
    }

    // Accumulate into the 512-sample inference window.
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      this.windowBuf[this.windowLen++] = frame[i] / 32768;
      if (this.windowLen === WINDOW_SAMPLES) {
        const window = this.windowBuf.slice();
        this.windowLen = 0;
        void this.infer(window);
      }
    }
  }

  private async infer(window: Float32Array): Promise<void> {
    // Silero inference is ~1ms on CPU; if a window arrives while the previous
    // one is still running we drop it rather than queueing (keeps latency bounded).
    if (this.inferring || !this.session) return;
    this.inferring = true;
    try {
      const input = new ort.Tensor('float32', window, [1, WINDOW_SAMPLES]);
      const sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);
      let prob: number;
      if (this.isV5) {
        const out = await this.session.run({ input, state: this.state!, sr });
        this.state = out['stateN'] as ort.Tensor;
        prob = (out['output'].data as Float32Array)[0];
      } else {
        const out = await this.session.run({ input, h: this.stateH!, c: this.stateC!, sr });
        this.stateH = out['hn'] as ort.Tensor;
        this.stateC = out['cn'] as ort.Tensor;
        prob = (out['output'].data as Float32Array)[0];
      }
      this.onProbability(prob);
    } catch (err) {
      logger.warn(`VAD inference failed: ${(err as Error).message}`);
    } finally {
      this.inferring = false;
    }
  }

  private onProbability(prob: number): void {
    if (!this.speaking) {
      if (prob > this.enterThreshold) {
        this.aboveCount++;
        if (this.aboveCount >= ENTER_WINDOWS) {
          this.speaking = true;
          this.aboveCount = 0;
          this.belowCount = 0;
          this.segmentStartedAt = Date.now();
          const preroll = this.preroll;
          this.preroll = [];
          this.events.onSegmentStart(preroll);
          this.events.onSpeakingChange(true);
        }
      } else {
        this.aboveCount = 0;
      }
    } else {
      if (prob < this.exitThreshold) {
        this.belowCount++;
        if (this.belowCount >= EXIT_WINDOWS) {
          this.endSegment();
        }
      } else {
        this.belowCount = 0;
      }
    }
  }

  private endSegment(): void {
    if (!this.speaking) return;
    this.speaking = false;
    this.aboveCount = 0;
    this.belowCount = 0;
    this.events.onSegmentEnd();
    this.events.onSpeakingChange(false);
  }

  /** Flush current segment (e.g. capture stopped or pause pressed). */
  reset(): void {
    this.endSegment();
    this.windowLen = 0;
    this.preroll = [];
    this.resetModelState();
  }
}
