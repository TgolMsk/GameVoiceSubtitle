import { app, globalShortcut, Menu, nativeImage, Tray } from 'electron';
import * as path from 'path';
import type { RuntimeStatus, ConnectionState, CaptureMode } from '@shared/types';
import { IPC } from '@shared/types';
import { t } from '@shared/i18n';
import { logger } from './logger';
import { configStore } from './store/config';
import { AudioCapture, checkPlatformSupport } from './audio/capture';
import { Resampler, frameRms, frameToBuffer } from './audio/resampler';
import { VadGate } from './audio/vad';
import { GummyClient } from './asr/gummyClient';
import { SubtitleStore } from './store/subtitleStore';
import { OverlayWindow } from './windows/overlayWindow';
import { SettingsWindow } from './windows/settingsWindow';
import { registerIpc } from './ipc';

/**
 * Application runtime: owns the audio → VAD → ASR pipeline and all windows.
 * Renderers are pure views; every piece of state lives here.
 */
class AppRuntime {
  private overlay = new OverlayWindow();
  private settings = new SettingsWindow();
  private tray: Tray | null = null;

  private resampler = new Resampler();
  private capture: AudioCapture;
  private vad: VadGate;
  private gummy: GummyClient;
  private subtitles: SubtitleStore;

  private status: RuntimeStatus = {
    connection: 'disconnected',
    connectionError: null,
    authFailed: false,
    capture: 'off',
    captureProcessName: null,
    speaking: false,
    paused: false,
    overlayVisible: true,
    uploadedSecondsMonth: 0,
  };

  /** Meter throttle state: peak RMS since last emit. */
  private meterPeak = 0;
  private meterTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.capture = new AudioCapture({
      onData: (chunk) => this.onCaptureData(chunk),
      onModeChange: (mode) => this.onCaptureModeChange(mode),
      onError: (message) => {
        logger.error(`capture error: ${message}`);
        this.trayBalloon(`Audio capture: ${message}`);
      },
    });

    this.vad = new VadGate({
      onSegmentStart: (preroll) => {
        if (!this.gummy.startSegment()) return;
        for (const frame of preroll) this.gummy.pushAudio(frameToBuffer(frame));
      },
      onSpeechFrame: (frame) => this.gummy.pushAudio(frameToBuffer(frame)),
      onSegmentEnd: () => this.gummy.endSegment(),
      onSpeakingChange: (speaking) => {
        this.status.speaking = speaking;
        this.broadcastStatus();
      },
    });

    this.gummy = new GummyClient(
      {
        onResult: (result) => {
          logger.debug(`result: ${JSON.stringify(result)}`);
          this.subtitles.applyResult(result);
        },
        onStateChange: (state, errorMessage, authFailed) => this.onConnectionState(state, errorMessage, authFailed),
        onTaskFailed: (code, message, authFailed) => {
          this.trayBalloon(
            authFailed
              ? t(configStore.get().uiLanguage, 'testFailAuth')
              : `Gummy task failed: ${code} ${message}`,
          );
        },
        onAudioUploaded: (seconds) => {
          configStore.addUsageSeconds(seconds);
          this.status.uploadedSecondsMonth = configStore.get().usageSeconds;
          // Not broadcast on every pack — status piggybacks on other updates.
        },
      },
      () => {
        const c = configStore.get();
        return { apiKey: c.apiKey.trim(), sourceLanguage: c.sourceLanguage, targetLanguage: c.targetLanguage };
      },
    );

    this.subtitles = new SubtitleStore((entries) => {
      this.overlay.send(IPC.SubtitleUpdate, entries);
    });
  }

  async start(): Promise<void> {
    const config = configStore.get();
    logger.setDebugEnabled(config.debugLogging);
    logger.info(`app start v${app.getVersion()} platform=${process.platform} arch=${process.arch}`);

    const platformIssue = checkPlatformSupport();
    if (platformIssue) {
      logger.warn(`platform limitation: ${platformIssue} (audio capture disabled)`);
    }

    registerIpc({
      getStatus: () => this.getStatus(),
      togglePause: () => this.togglePause(),
      toggleOverlay: () => this.toggleOverlay(),
      setEditMode: (enabled) => this.overlay.setEditMode(enabled),
      onApiKeyChanged: () => {
        this.gummy.resetAuth();
        this.gummy.disconnect();
        this.gummy.connect();
      },
    });

    this.overlay.create();
    this.createTray();
    this.registerHotkeys(config.hotkeyToggleOverlay, config.hotkeyTogglePause);
    this.subtitles.configure(config.maxEntries, config.entryTtlSeconds);
    this.vad.setSensitivity(config.vadSensitivity);
    this.applyAutoLaunch(config.autoLaunch);

    try {
      await this.vad.init();
    } catch (err) {
      logger.error(`VAD init failed: ${(err as Error).message}`);
      this.trayBalloon(`VAD init failed: ${(err as Error).message}`);
    }

    this.status.uploadedSecondsMonth = config.usageSeconds;

    configStore.onChange((c, keys) => this.onConfigChange(c, keys));

    // Start the pipeline if configured.
    if (!platformIssue) this.startCapture();
    if (config.apiKey) this.gummy.connect();

    this.startMeterTimer();

    if (process.env['GVS_DEMO']) this.runDemo();
  }

  /**
   * Dev-only smoke test (GVS_DEMO=1): pushes synthetic Gummy results through
   * the real SubtitleStore → IPC → overlay path, then dumps a capturePage()
   * screenshot next to the logs. Never active in normal runs.
   */
  private runDemo(): void {
    const feed = (sentenceId: number, src: string, dst: string, final: boolean) =>
      this.subtitles.applyResult({
        taskId: 'demo-task',
        transcription: { sentence_id: sentenceId, text: src, sentence_end: final },
        translations: [{ sentence_id: sentenceId, lang: 'zh', text: dst, sentence_end: final }],
      });
    setTimeout(() => feed(0, "Let's rotate", '我们转', false), 1500);
    setTimeout(() => feed(0, "Let's rotate to B site.", '我们转去 B 点。', true), 2500);
    setTimeout(() => feed(1, 'Enemy spotted mid, two pushing', '中路发现敌人,两个在推进', false), 3500);
    setTimeout(() => {
      this.status.speaking = true;
      this.broadcastStatus();
      this.overlay.send(IPC.MeterUpdate, 0.2);
    }, 3600);
    setTimeout(() => {
      const fs = require('fs') as typeof import('fs');
      const capture = (win: Electron.BrowserWindow | null, name: string) => {
        if (!win || win.isDestroyed()) return;
        void win.webContents.capturePage().then((img) => {
          const out = path.join(app.getPath('userData'), `demo-${name}.png`);
          fs.writeFileSync(out, img.toPNG());
          logger.info(`demo screenshot written: ${out}`);
        });
      };
      capture(this.overlay.window, 'overlay');
      capture(this.settings.currentWindow, 'settings');
    }, 4500);
  }

  // ---- pipeline ------------------------------------------------------------

  private startCapture(): void {
    const c = configStore.get();
    this.resampler.reset();
    this.capture.start(c.captureProcessId, c.captureProcessTree);
  }

  private onCaptureData(chunk: Buffer): void {
    if (this.status.paused) return;
    // 48k stereo → 16k mono 20ms frames; feed meter + VAD. VAD forwards
    // speech-only audio to Gummy — silence never reaches the network.
    const frames = this.resampler.process(chunk);
    for (const frame of frames) {
      const rms = frameRms(frame);
      if (rms > this.meterPeak) this.meterPeak = rms;
      this.vad.pushFrame(frame);
    }
  }

  private onCaptureModeChange(mode: CaptureMode): void {
    this.status.capture = mode;
    this.status.captureProcessName = mode === 'process' ? configStore.get().captureProcessName : null;
    this.broadcastStatus();
  }

  private onConnectionState(state: ConnectionState, errorMessage: string | null, authFailed: boolean): void {
    this.status.connection = state;
    this.status.connectionError = errorMessage;
    this.status.authFailed = authFailed;
    this.broadcastStatus();
    this.updateTray();
    if (authFailed && errorMessage) {
      this.trayBalloon(t(configStore.get().uiLanguage, 'testFailAuth'));
    }
  }

  private startMeterTimer(): void {
    // 10Hz meter updates; cheap and smooth enough for a volume bar.
    this.meterTimer = setInterval(() => {
      this.overlay.send(IPC.MeterUpdate, this.meterPeak);
      this.meterPeak = 0;
    }, 100);
    this.meterTimer.unref();
  }

  private togglePause(): void {
    this.status.paused = !this.status.paused;
    if (this.status.paused) {
      this.vad.reset(); // closes any in-flight segment
    }
    logger.info(`recognition ${this.status.paused ? 'paused' : 'resumed'}`);
    this.broadcastStatus();
    this.updateTray();
  }

  private toggleOverlay(): void {
    this.status.overlayVisible = this.overlay.toggleVisible();
    this.broadcastStatus();
    this.updateTray();
  }

  // ---- config reactions ----------------------------------------------------

  private onConfigChange(c: ReturnType<typeof configStore.get>, keys: (keyof ReturnType<typeof configStore.get>)[]): void {
    const has = (k: keyof typeof c) => keys.includes(k);

    if (has('captureProcessId') || has('captureProcessTree')) this.startCapture();
    if (has('vadSensitivity')) this.vad.setSensitivity(c.vadSensitivity);
    if (has('maxEntries') || has('entryTtlSeconds')) this.subtitles.configure(c.maxEntries, c.entryTtlSeconds);
    if (has('debugLogging')) logger.setDebugEnabled(c.debugLogging);
    if (has('displayId')) this.overlay.layout();
    if (has('hotkeyToggleOverlay') || has('hotkeyTogglePause')) {
      this.registerHotkeys(c.hotkeyToggleOverlay, c.hotkeyTogglePause);
    }
    if (has('autoLaunch')) this.applyAutoLaunch(c.autoLaunch);
    if (has('uiLanguage')) this.updateTray();

    // Push the fresh config to both renderers (overlay restyles itself).
    this.overlay.send(IPC.ConfigChanged, c);
    this.settings.send(IPC.ConfigChanged, c);
  }

  private registerHotkeys(toggleOverlay: string, togglePause: string): void {
    globalShortcut.unregisterAll();
    const tryRegister = (accelerator: string, handler: () => void, label: string) => {
      try {
        if (!globalShortcut.register(accelerator, handler)) {
          logger.warn(`hotkey registration failed: ${label} = ${accelerator}`);
        }
      } catch (err) {
        logger.warn(`hotkey invalid: ${label} = ${accelerator} (${(err as Error).message})`);
      }
    };
    tryRegister(toggleOverlay, () => this.toggleOverlay(), 'toggle-overlay');
    tryRegister(togglePause, () => this.togglePause(), 'toggle-pause');
  }

  private applyAutoLaunch(enabled: boolean): void {
    if (!app.isPackaged) return; // avoid registering the dev electron binary
    app.setLoginItemSettings({ openAtLogin: enabled });
  }

  // ---- tray ----------------------------------------------------------------

  private trayIcon(name: string): Electron.NativeImage {
    const base = app.isPackaged
      ? path.join(process.resourcesPath, 'resources')
      : path.join(app.getAppPath(), 'resources');
    return nativeImage.createFromPath(path.join(base, `${name}.png`));
  }

  private trayState(): 'active' | 'idle' | 'paused' | 'error' {
    if (this.status.connection === 'error') return 'error';
    if (this.status.paused) return 'paused';
    if (this.status.connection === 'reconnecting') return 'paused';
    if (this.status.capture !== 'off' && this.status.connection === 'connected') return 'active';
    return 'idle';
  }

  private createTray(): void {
    this.tray = new Tray(this.trayIcon('tray-idle'));
    this.tray.on('double-click', () => this.settings.show());
    this.updateTray();
  }

  private updateTray(): void {
    if (!this.tray) return;
    const lang = configStore.get().uiLanguage;
    const state = this.trayState();
    this.tray.setImage(this.trayIcon(`tray-${state}`));
    const stateLabel = {
      active: t(lang, 'trayStatusRunning'),
      idle: t(lang, 'trayStatusIdle'),
      paused: t(lang, 'trayStatusPaused'),
      error: t(lang, 'trayStatusError'),
    }[state];
    this.tray.setToolTip(`GameVoiceSubtitle — ${stateLabel}`);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: t(lang, 'trayShowHide'), click: () => this.toggleOverlay() },
        {
          label: this.status.paused ? t(lang, 'trayResume') : t(lang, 'trayPause'),
          click: () => this.togglePause(),
        },
        { label: t(lang, 'trayEditPosition'), click: () => this.overlay.setEditMode(!this.overlay.isEditMode) },
        { type: 'separator' },
        { label: t(lang, 'traySettings'), click: () => this.settings.show() },
        { label: t(lang, 'trayLogs'), click: () => void import('electron').then(({ shell }) => shell.openPath(logger.dir)) },
        { type: 'separator' },
        { label: t(lang, 'trayQuit'), click: () => this.quit() },
      ]),
    );
  }

  private trayBalloon(content: string): void {
    logger.info(`notify: ${content}`);
    if (process.platform === 'win32') {
      this.tray?.displayBalloon({ title: 'GameVoiceSubtitle', content });
    }
  }

  // ---- misc ----------------------------------------------------------------

  private getStatus(): RuntimeStatus {
    return { ...this.status, uploadedSecondsMonth: configStore.get().usageSeconds };
  }

  private broadcastStatus(): void {
    const status = this.getStatus();
    this.overlay.send(IPC.StatusUpdate, status);
    this.settings.send(IPC.StatusUpdate, status);
  }

  showSettings(): void {
    this.settings.show();
  }

  quit(): void {
    logger.info('quitting');
    this.capture.stop();
    this.gummy.disconnect();
    globalShortcut.unregisterAll();
    this.overlay.destroy();
    this.settings.destroy();
    this.tray?.destroy();
    app.quit();
  }
}

// ---- bootstrap -------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const runtime = new AppRuntime();

  app.on('second-instance', () => runtime.showSettings());

  // Tray app: keep running when all windows are closed.
  app.on('window-all-closed', (e: Electron.Event) => e.preventDefault());

  app.whenReady().then(async () => {
    await runtime.start();
    // First run without an API key → open settings so the user can configure it.
    if (!configStore.get().apiKey) runtime.showSettings();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
}
