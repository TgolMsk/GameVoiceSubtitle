/** Wire types for the DashScope realtime ASR WebSocket protocol (Gummy / Paraformer). */

import type { AsrEngine } from '@shared/types';

export const GUMMY_WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/';
export const GUMMY_MODEL = 'gummy-realtime-v1';
export const PARAFORMER_MODEL = 'paraformer-realtime-v2';

export const ENGINE_MODELS: Record<AsrEngine, string> = {
  gummy: GUMMY_MODEL,
  paraformer: PARAFORMER_MODEL,
};

export interface RunTaskMessage {
  header: {
    action: 'run-task';
    task_id: string;
    streaming: 'duplex';
  };
  payload: {
    model: string;
    task_group: 'audio';
    task: 'asr';
    function: 'recognition';
    /**
     * Gummy:      sample_rate/format + transcription_enabled/translation_enabled/
     *             translation_target_languages/source_language
     * Paraformer: sample_rate/format + optional language_hints (v2 only)
     */
    parameters: Record<string, unknown>;
    input: Record<string, never>;
  };
}

export interface FinishTaskMessage {
  header: {
    action: 'finish-task';
    task_id: string;
    streaming: 'duplex';
  };
  payload: { input: Record<string, never> };
}

export interface GummySentence {
  sentence_id: number;
  begin_time?: number;
  end_time?: number | null;
  text: string;
  sentence_end: boolean;
}

export interface GummyTranslation extends GummySentence {
  lang: string;
}

/** Paraformer result sentence — no sentence_id; the client synthesizes one. */
export interface ParaformerSentence {
  begin_time?: number;
  end_time?: number | null;
  text: string;
  sentence_end?: boolean;
  words?: unknown[];
}

export interface DownstreamMessage {
  header: {
    task_id: string;
    event: 'task-started' | 'result-generated' | 'task-finished' | 'task-failed';
    error_code?: string;
    error_message?: string;
  };
  payload?: {
    output?: {
      // Gummy shape
      transcription?: GummySentence;
      translations?: GummyTranslation[];
      // Paraformer shape
      sentence?: ParaformerSentence;
    };
  };
}

/**
 * Unified result event. For Paraformer, `transcription.sentence_id` is
 * synthesized by the client (monotonic per task) and `translations` is absent —
 * the translator layer fills translations in asynchronously on finals.
 */
export interface GummyResultEvent {
  taskId: string;
  transcription?: GummySentence;
  translations?: GummyTranslation[];
}
