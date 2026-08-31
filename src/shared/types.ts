// Types shared between main process and renderer processes.
// Keep this file free of any Electron/Node imports — it is bundled into both sides.

/** A single subtitle entry as rendered by the overlay. */
export interface SubtitleEntry {
  /** Unique id: `${taskId}:${sentenceId}` — stable across partial updates of one sentence. */
  id: string;
  sentenceId: number;
  sourceText: string;
  translatedText: string;
  isFinal: boolean;
  createdAt: number;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export type CaptureMode = 'process' | 'system' | 'off';

/** Aggregate runtime status pushed to renderers. */
export interface RuntimeStatus {
  connection: ConnectionState;
  /** Human-readable reason for error state (already localized-neutral, raw message). */
  connectionError: string | null;
  /** True while an auth (API key) failure is the cause of the error state. */
  authFailed: boolean;
  capture: CaptureMode;
  captureProcessName: string | null;
  /** VAD currently detects speech. */
  speaking: boolean;
  paused: boolean;
  overlayVisible: boolean;
  /** Cumulative seconds of audio uploaded to the API (for cost estimation). */
  uploadedSecondsMonth: number;
}

export interface AudioProcessInfo {
  pid: number;
  name: string;
}

export type SourceLanguage =
  | 'auto'
  | 'zh'
  | 'en'
  | 'ja'
  | 'ko'
  | 'yue'
  | 'de'
  | 'fr'
  | 'ru'
  | 'es'
  | 'it'
  | 'pt'
  | 'id'
  | 'ar'
  | 'th';

export type TargetLanguage = Exclude<SourceLanguage, 'auto'>;

export type SubtitlePosition = 'top' | 'middle' | 'bottom';

/**
 * gummy      — gummy-realtime-v1: ASR + translation in one streaming task.
 * paraformer — paraformer-realtime-v2: ASR only; finals are translated
 *              separately via qwen-mt-turbo.
 */
export type AsrEngine = 'gummy' | 'paraformer';

export interface AppConfig {
  apiKey: string;
  asrEngine: AsrEngine;
  /** PID of the process to capture; null means "system audio". */
  captureProcessId: number | null;
  captureProcessName: string | null;
  captureProcessTree: boolean;
  sourceLanguage: SourceLanguage;
  targetLanguage: TargetLanguage;
  /** Display settings */
  fontSize: number;
  position: SubtitlePosition;
  /** Extra vertical offset in percent of screen height (positive moves down). */
  verticalOffsetPct: number;
  backgroundOpacity: number;
  maxEntries: number;
  entryTtlSeconds: number;
  showSourceText: boolean;
  displayId: number | null;
  /** Hotkeys (Electron accelerator strings). */
  hotkeyToggleOverlay: string;
  hotkeyTogglePause: string;
  /** 0..1, mapped onto VAD enter threshold. */
  vadSensitivity: number;
  autoLaunch: boolean;
  uiLanguage: 'zh' | 'en';
  debugLogging: boolean;
  /** Usage accounting: seconds uploaded, reset monthly. */
  usageSeconds: number;
  usageMonth: string;
}

/** IPC channel names — single source of truth. */
export const IPC = {
  // main -> overlay renderer
  SubtitleUpdate: 'subtitle:update',
  StatusUpdate: 'status:update',
  MeterUpdate: 'meter:update',
  OverlayEditMode: 'overlay:edit-mode',
  ConfigChanged: 'config:changed',
  // renderer -> main (invoke)
  ConfigGet: 'config:get',
  ConfigSet: 'config:set',
  ProcessesList: 'processes:list',
  StatusGet: 'status:get',
  TestConnection: 'gummy:test',
  SetEditMode: 'overlay:set-edit-mode',
  TogglePause: 'control:toggle-pause',
  ToggleOverlay: 'control:toggle-overlay',
  ListDisplays: 'displays:list',
  OpenLogs: 'logs:open',
} as const;

export interface DisplayInfo {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  primary: boolean;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  authFailed: boolean;
}

/** API surface exposed by the preload script. */
export interface RendererApi {
  getConfig(): Promise<AppConfig>;
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  listProcesses(): Promise<AudioProcessInfo[]>;
  listDisplays(): Promise<DisplayInfo[]>;
  getStatus(): Promise<RuntimeStatus>;
  testConnection(apiKey: string): Promise<TestConnectionResult>;
  setEditMode(enabled: boolean): Promise<void>;
  togglePause(): Promise<void>;
  toggleOverlay(): Promise<void>;
  openLogs(): Promise<void>;
  onSubtitles(cb: (entries: SubtitleEntry[]) => void): () => void;
  onStatus(cb: (status: RuntimeStatus) => void): () => void;
  onMeter(cb: (level: number) => void): () => void;
  onEditMode(cb: (enabled: boolean) => void): () => void;
  onConfigChanged(cb: (config: AppConfig) => void): () => void;
}
