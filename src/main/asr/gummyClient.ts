import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import type { AsrEngine, ConnectionState } from '@shared/types';
import { logger } from '../logger';
import {
  DownstreamMessage,
  ENGINE_MODELS,
  FinishTaskMessage,
  GUMMY_WS_URL,
  GummyResultEvent,
  RunTaskMessage,
} from './types';

/** Endpoint override hook — used by integration tests (mock server) only. */
function resolveWsUrl(): string {
  return process.env['GVS_GUMMY_URL'] ?? GUMMY_WS_URL;
}

const AUTH_ERROR_HINTS = ['invalidapikey', 'unauthorized', 'accessdenied', 'invalid_api_key', '401', '403'];
const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const KEEPALIVE_INTERVAL_MS = 30_000;
const UPLOAD_FLUSH_INTERVAL_MS = 100;
const BYTES_PER_SECOND = 16000 * 2; // 16kHz mono int16

export interface GummyClientEvents {
  onResult(result: GummyResultEvent): void;
  onStateChange(state: ConnectionState, errorMessage: string | null, authFailed: boolean): void;
  onTaskFailed(errorCode: string, errorMessage: string, authFailed: boolean): void;
  /** Cumulative seconds of PCM actually uploaded (for cost accounting). */
  onAudioUploaded(seconds: number): void;
}

export interface GummyParams {
  apiKey: string;
  engine: AsrEngine;
  sourceLanguage: string; // 'auto' or ISO code
  targetLanguage: string;
}

type TaskPhase = 'idle' | 'starting' | 'running' | 'finishing';

/**
 * DashScope Gummy realtime client.
 *
 * One WebSocket connection is reused across many tasks: each VAD speech segment
 * maps to one run-task/finish-task pair. Audio arriving before `task-started`
 * is queued and flushed as soon as the task is live; audio arriving while the
 * connection is down is DROPPED (per spec — no backlog during reconnect).
 */
export class GummyClient {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private authFailed = false;

  private taskId: string | null = null;
  private taskPhase: TaskPhase = 'idle';
  /** Frames waiting to be sent (either pre-task-started queue or 100ms pack buffer). */
  private sendQueue: Buffer[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  /** Segment ended before task-started arrived — finish as soon as it does. */
  private finishPending = false;
  /** Engine the current task was started with (params may change mid-connection). */
  private taskEngine: AsrEngine = 'gummy';
  /** Paraformer sends no sentence_id — synthesize one, bumped on each sentence_end. */
  private sentenceCounter = 0;

  private keepaliveTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffIndex = 0;
  private closedByUs = false;

  constructor(
    private events: GummyClientEvents,
    private getParams: () => GummyParams,
  ) {}

  get connectionState(): ConnectionState {
    return this.state;
  }

  private setState(state: ConnectionState, errorMessage: string | null = null): void {
    this.state = state;
    this.events.onStateChange(state, errorMessage, this.authFailed);
  }

  /** Opens the connection if needed. Safe to call repeatedly. */
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const { apiKey } = this.getParams();
    if (!apiKey) {
      this.authFailed = true;
      this.setState('error', 'API key is not configured');
      return;
    }
    this.closedByUs = false;
    this.setState(this.backoffIndex > 0 ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(resolveWsUrl(), {
      headers: { Authorization: `bearer ${apiKey}` },
      handshakeTimeout: 10_000,
    });
    this.ws = ws;

    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      this.authFailed = status === 401 || status === 403;
      logger.error(`Gummy handshake rejected: HTTP ${status}`);
      ws.terminate();
      if (this.authFailed) {
        // Bad key — retrying is pointless, wait for the user to fix it in settings.
        this.setState('error', `Authentication failed (HTTP ${status}) — check your API key`);
      } else {
        this.setState('error', `Handshake failed (HTTP ${status})`);
        this.scheduleReconnect();
      }
    });

    ws.on('open', () => {
      this.backoffIndex = 0;
      this.authFailed = false;
      this.setState('connected');
      this.startKeepalive();
      logger.info('Gummy WebSocket connected');
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      this.handleMessage(String(data));
    });

    ws.on('error', (err) => {
      logger.warn(`Gummy WebSocket error: ${err.message}`);
    });

    ws.on('close', (code, reason) => {
      this.stopKeepalive();
      this.abortTask();
      this.ws = null;
      if (this.closedByUs || this.authFailed) return;
      logger.warn(`Gummy WebSocket closed (${code} ${String(reason)})`);
      this.scheduleReconnect();
    });
  }

  disconnect(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopKeepalive();
    this.abortTask();
    this.ws?.close();
    this.ws = null;
    this.backoffIndex = 0;
    this.setState('disconnected');
  }

  /** Called after the user updates the API key — clears the sticky auth-error state. */
  resetAuth(): void {
    this.authFailed = false;
    this.backoffIndex = 0;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByUs) return;
    const delay = BACKOFF_STEPS_MS[Math.min(this.backoffIndex, BACKOFF_STEPS_MS.length - 1)];
    this.backoffIndex++;
    this.setState('reconnecting');
    logger.info(`Gummy reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // ---- keepalive -----------------------------------------------------------

  /**
   * DashScope drops connections idle for ~60s. There is no documented
   * application-level heartbeat, so we use WebSocket protocol pings every 30s;
   * if the server drops us anyway, the close handler reconnects transparently.
   */
  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {
          /* close handler deals with it */
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  // ---- task lifecycle ------------------------------------------------------

  /** Begin a task for a new VAD speech segment. Returns false if audio should be dropped. */
  startSegment(): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Per spec: drop audio during reconnect instead of queueing it.
      this.connect();
      return false;
    }
    if (this.taskPhase === 'finishing') {
      // Previous task's finish-task is already on the wire; audio appended now
      // would be invalid. Rare race (VAD hangover is 500ms) — drop this segment.
      return false;
    }
    if (this.taskPhase !== 'idle') {
      // starting/running: segment boundaries raced; keep streaming into the live task.
      this.finishPending = false;
      return true;
    }
    this.taskId = randomUUID();
    this.taskPhase = 'starting';
    this.finishPending = false;
    this.sendQueue = [];
    this.sentenceCounter = 0;
    const { engine, sourceLanguage, targetLanguage } = this.getParams();
    this.taskEngine = engine;
    const parameters: Record<string, unknown> =
      engine === 'paraformer'
        ? {
            sample_rate: 16000,
            format: 'pcm',
            // v2 accepts optional language hints; 'auto' means no hint.
            ...(sourceLanguage !== 'auto' ? { language_hints: [sourceLanguage] } : {}),
          }
        : {
            sample_rate: 16000,
            format: 'pcm',
            transcription_enabled: true,
            translation_enabled: true,
            translation_target_languages: [targetLanguage],
            source_language: sourceLanguage,
          };
    const msg: RunTaskMessage = {
      header: { action: 'run-task', task_id: this.taskId, streaming: 'duplex' },
      payload: {
        model: ENGINE_MODELS[engine],
        task_group: 'audio',
        task: 'asr',
        function: 'recognition',
        parameters,
        input: {},
      },
    };
    this.ws.send(JSON.stringify(msg));
    logger.debug(`run-task sent (${this.taskId}, ${ENGINE_MODELS[engine]})`);
    return true;
  }

  /** Queue one PCM buffer (16k/16bit/mono LE) for upload. */
  pushAudio(pcm: Buffer): void {
    if (this.taskPhase === 'idle' || this.taskPhase === 'finishing') return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.sendQueue.push(pcm);
    if (this.taskPhase === 'running' && !this.flushTimer) {
      // Pack ~100ms of audio per binary frame instead of one frame per 20ms.
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushAudio();
      }, UPLOAD_FLUSH_INTERVAL_MS);
    }
  }

  /** Current VAD segment is over — finish the task once queued audio is out. */
  endSegment(): void {
    if (this.taskPhase === 'starting') {
      this.finishPending = true;
      return;
    }
    if (this.taskPhase === 'running') {
      this.flushAudio();
      this.sendFinishTask();
    }
  }

  private flushAudio(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.sendQueue.length === 0) return;
    const pack = Buffer.concat(this.sendQueue);
    this.sendQueue = [];
    this.ws.send(pack);
    this.events.onAudioUploaded(pack.byteLength / BYTES_PER_SECOND);
  }

  private sendFinishTask(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.taskId) return;
    const msg: FinishTaskMessage = {
      header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' },
      payload: { input: {} },
    };
    this.ws.send(JSON.stringify(msg));
    this.taskPhase = 'finishing';
    logger.debug(`finish-task sent (${this.taskId})`);
  }

  private abortTask(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.sendQueue = [];
    this.taskId = null;
    this.taskPhase = 'idle';
    this.finishPending = false;
  }

  // ---- downstream ----------------------------------------------------------

  private handleMessage(raw: string): void {
    let msg: DownstreamMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      logger.warn('Gummy sent unparseable message');
      return;
    }
    const { event, task_id } = msg.header;
    switch (event) {
      case 'task-started': {
        if (task_id !== this.taskId) return;
        this.taskPhase = 'running';
        this.flushAudio(); // release audio buffered during the handshake
        if (this.finishPending) {
          this.finishPending = false;
          this.sendFinishTask();
        }
        break;
      }
      case 'result-generated': {
        const output = msg.payload?.output;
        if (!output) return;
        if (this.taskEngine === 'paraformer') {
          const sentence = output.sentence;
          if (!sentence || typeof sentence.text !== 'string') return;
          // Partials have end_time null; a completed sentence sets sentence_end
          // (and/or a real end_time). Synthesize a stable per-task sentence id.
          const isFinal = sentence.sentence_end === true || (sentence.end_time ?? null) !== null;
          const sentenceId = this.sentenceCounter;
          if (isFinal) this.sentenceCounter++;
          this.events.onResult({
            taskId: task_id,
            transcription: {
              sentence_id: sentenceId,
              begin_time: sentence.begin_time,
              end_time: sentence.end_time,
              text: sentence.text,
              sentence_end: isFinal,
            },
          });
        } else {
          this.events.onResult({
            taskId: task_id,
            transcription: output.transcription,
            translations: output.translations,
          });
        }
        break;
      }
      case 'task-finished': {
        if (task_id === this.taskId) this.abortTask();
        break;
      }
      case 'task-failed': {
        const code = msg.header.error_code ?? 'unknown';
        const message = msg.header.error_message ?? 'unknown error';
        const lowered = `${code} ${message}`.toLowerCase();
        const authFailed = AUTH_ERROR_HINTS.some((h) => lowered.includes(h));
        logger.error(`Gummy task-failed: code=${code} message=${message}`);
        if (task_id === this.taskId) this.abortTask();
        if (authFailed) {
          this.authFailed = true;
          this.setState('error', `Authentication failed: ${message}`);
        }
        this.events.onTaskFailed(code, message, authFailed);
        break;
      }
    }
  }
}

/**
 * Standalone connectivity test for the settings screen. The bearer token is
 * validated during the HTTP upgrade, so a successful open proves the key works.
 */
export function testGummyConnection(apiKey: string): Promise<{ ok: boolean; message: string; authFailed: boolean }> {
  return new Promise((resolve) => {
    if (!apiKey.trim()) {
      resolve({ ok: false, message: 'empty-key', authFailed: true });
      return;
    }
    const ws = new WebSocket(resolveWsUrl(), {
      headers: { Authorization: `bearer ${apiKey.trim()}` },
      handshakeTimeout: 8000,
    });
    const timeout = setTimeout(() => {
      ws.terminate();
      resolve({ ok: false, message: 'timeout', authFailed: false });
    }, 10_000);
    ws.on('open', () => {
      clearTimeout(timeout);
      ws.close();
      resolve({ ok: true, message: 'ok', authFailed: false });
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timeout);
      ws.terminate();
      const status = res.statusCode ?? 0;
      resolve({ ok: false, message: `HTTP ${status}`, authFailed: status === 401 || status === 403 });
    });
    ws.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, message: err.message, authFailed: false });
    });
  });
}
