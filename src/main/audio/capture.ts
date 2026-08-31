import { execFile } from 'child_process';
import * as os from 'os';
import type { AudioProcessInfo, CaptureMode } from '@shared/types';
import { logger } from '../logger';

// loopback-capture's native addon only loads on Windows 10 x64 2004+.
// Lazy-require so the app still starts (for development / friendly errors) elsewhere.
type NativeCapture = {
  start: (processId: number, includeProcessTree: boolean, callback: (chunk: Buffer) => void) => void;
  stop: () => void;
  startSystemAudio: (callback: (chunk: Buffer) => void) => void;
};

let nativeCtor: (new () => NativeCapture) | null | undefined;

function loadNative(): (new () => NativeCapture) | null {
  if (nativeCtor !== undefined) return nativeCtor;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('loopback-capture');
    nativeCtor = (mod.default ?? mod).LoopbackCapture as new () => NativeCapture;
  } catch (err) {
    logger.warn(`loopback-capture native module unavailable: ${(err as Error).message}`);
    nativeCtor = null;
  }
  return nativeCtor;
}

/**
 * Process loopback needs Windows 10 x64 2004 (build 19041) or newer.
 * Returns null when supported, otherwise a machine-readable reason.
 */
export function checkPlatformSupport(): 'not-windows' | 'windows-too-old' | 'not-x64' | null {
  if (process.platform !== 'win32') return 'not-windows';
  if (process.arch !== 'x64' && process.arch !== 'arm64') return 'not-x64';
  const build = Number(os.release().split('.')[2] ?? 0);
  if (build < 19041) return 'windows-too-old';
  return null;
}

/**
 * Enumerates candidate processes for capture.
 *
 * Ideal would be "processes currently rendering audio" (WASAPI session enumeration),
 * but that needs native code we don't have; per spec we degrade to "all processes
 * with a window + known voice apps first", and the settings UI provides a search box.
 */
export function listAudioProcesses(): Promise<AudioProcessInfo[]> {
  if (process.platform !== 'win32') {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        logger.warn(`tasklist failed: ${err.message}`);
        resolve([]);
        return;
      }
      const seen = new Map<string, AudioProcessInfo>();
      for (const line of stdout.split(/\r?\n/)) {
        // CSV columns: "Image Name","PID","Session Name","Session#","Mem Usage"
        const match = line.match(/^"([^"]+)","(\d+)"/);
        if (!match) continue;
        const name = match[1];
        const pid = Number(match[2]);
        if (SYSTEM_PROCESS_BLOCKLIST.has(name.toLowerCase())) continue;
        // Keep the first (usually main) PID per image name to keep the list short.
        if (!seen.has(name)) seen.set(name, { pid, name });
      }
      const list = [...seen.values()];
      list.sort((a, b) => {
        const aVoice = VOICE_APP_HINTS.has(a.name.toLowerCase()) ? 0 : 1;
        const bVoice = VOICE_APP_HINTS.has(b.name.toLowerCase()) ? 0 : 1;
        return aVoice - bVoice || a.name.localeCompare(b.name);
      });
      resolve(list);
    });
  });
}

const VOICE_APP_HINTS = new Set([
  'discord.exe',
  'yy.exe',
  'kook.exe',
  'oopz.exe',
  'teamspeak3.exe',
  'ts3client_win64.exe',
  'mumble.exe',
  'wechat.exe',
  'qq.exe',
  'skype.exe',
  'steam.exe',
]);

const SYSTEM_PROCESS_BLOCKLIST = new Set([
  'system',
  'system idle process',
  'registry',
  'smss.exe',
  'csrss.exe',
  'wininit.exe',
  'winlogon.exe',
  'services.exe',
  'lsass.exe',
  'svchost.exe',
  'fontdrvhost.exe',
  'dwm.exe',
  'conhost.exe',
  'dllhost.exe',
  'runtimebroker.exe',
  'taskhostw.exe',
  'sihost.exe',
  'ctfmon.exe',
  'searchindexer.exe',
  'memory compression',
]);

export interface CaptureEvents {
  onData(chunk: Buffer): void;
  onModeChange(mode: CaptureMode): void;
  onError(message: string): void;
}

/**
 * Owns the native capture instance. Attempts process capture first and
 * transparently falls back to whole-system loopback when that fails.
 */
export class AudioCapture {
  private native: NativeCapture | null = null;
  private mode: CaptureMode = 'off';

  constructor(private events: CaptureEvents) {}

  get currentMode(): CaptureMode {
    return this.mode;
  }

  /** Starts capture. `processId === null` requests system-wide loopback directly. */
  start(processId: number | null, includeProcessTree: boolean): void {
    this.stop();
    const platformIssue = checkPlatformSupport();
    if (platformIssue) {
      this.events.onError(platformIssue);
      return;
    }
    const Ctor = loadNative();
    if (!Ctor) {
      this.events.onError('native-module-missing');
      return;
    }
    this.native = new Ctor();
    const onData = (chunk: Buffer) => this.events.onData(chunk);

    if (processId !== null) {
      try {
        this.native.start(processId, includeProcessTree, onData);
        this.mode = 'process';
        this.events.onModeChange('process');
        logger.info(`audio capture started (process ${processId}, tree=${includeProcessTree})`);
        return;
      } catch (err) {
        logger.warn(`process capture failed (${(err as Error).message}), falling back to system audio`);
      }
    }

    try {
      this.native.startSystemAudio(onData);
      this.mode = 'system';
      this.events.onModeChange('system');
      logger.info('audio capture started (system-wide loopback)');
    } catch (err) {
      this.native = null;
      this.mode = 'off';
      this.events.onModeChange('off');
      this.events.onError(`capture-failed: ${(err as Error).message}`);
    }
  }

  stop(): void {
    if (this.native) {
      try {
        this.native.stop();
      } catch (err) {
        logger.warn(`capture stop failed: ${(err as Error).message}`);
      }
      this.native = null;
    }
    if (this.mode !== 'off') {
      this.mode = 'off';
      this.events.onModeChange('off');
    }
  }
}
