/** Wire types for the DashScope Gummy realtime WebSocket protocol. */

export const GUMMY_WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/';
export const GUMMY_MODEL = 'gummy-realtime-v1';

export interface RunTaskMessage {
  header: {
    action: 'run-task';
    task_id: string;
    streaming: 'duplex';
  };
  payload: {
    model: typeof GUMMY_MODEL;
    task_group: 'audio';
    task: 'asr';
    function: 'recognition';
    parameters: {
      sample_rate: 16000;
      format: 'pcm';
      transcription_enabled: boolean;
      translation_enabled: boolean;
      translation_target_languages: string[];
      source_language?: string;
    };
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

export interface DownstreamMessage {
  header: {
    task_id: string;
    event: 'task-started' | 'result-generated' | 'task-finished' | 'task-failed';
    error_code?: string;
    error_message?: string;
  };
  payload?: {
    output?: {
      transcription?: GummySentence;
      translations?: GummyTranslation[];
    };
  };
}

export interface GummyResultEvent {
  taskId: string;
  transcription?: GummySentence;
  translations?: GummyTranslation[];
}
