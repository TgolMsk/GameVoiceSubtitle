import Store from 'electron-store';
import type { AppConfig } from '@shared/types';

const defaults: AppConfig = {
  apiKey: '',
  asrEngine: 'paraformer',
  captureProcessId: null,
  captureProcessName: null,
  captureProcessTree: true,
  sourceLanguage: 'auto',
  targetLanguage: 'zh',
  fontSize: 28,
  position: 'bottom',
  verticalOffsetPct: 0,
  backgroundOpacity: 0.45,
  maxEntries: 3,
  entryTtlSeconds: 8,
  showSourceText: true,
  displayId: null,
  hotkeyToggleOverlay: 'Control+Alt+S',
  hotkeyTogglePause: 'Control+Alt+P',
  vadSensitivity: 0.5,
  autoLaunch: false,
  uiLanguage: 'zh',
  debugLogging: false,
  usageSeconds: 0,
  usageMonth: '',
};

export type ConfigListener = (config: AppConfig, changedKeys: (keyof AppConfig)[]) => void;

class ConfigStore {
  private store = new Store<AppConfig>({ defaults, name: 'config' });
  private listeners = new Set<ConfigListener>();

  get(): AppConfig {
    return { ...defaults, ...this.store.store };
  }

  set(patch: Partial<AppConfig>): AppConfig {
    const keys = Object.keys(patch) as (keyof AppConfig)[];
    for (const key of keys) {
      const value = patch[key];
      if (value === undefined) continue;
      this.store.set(key, value);
    }
    const config = this.get();
    for (const listener of this.listeners) listener(config, keys);
    return config;
  }

  onChange(listener: ConfigListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Adds uploaded audio seconds to the monthly usage counter, resetting on month change. */
  addUsageSeconds(seconds: number): void {
    const month = new Date().toISOString().slice(0, 7);
    const config = this.get();
    const usageSeconds = config.usageMonth === month ? config.usageSeconds + seconds : seconds;
    // Direct store writes: usage ticks are frequent and must not spam config listeners.
    this.store.set('usageSeconds', usageSeconds);
    this.store.set('usageMonth', month);
  }
}

export const configStore = new ConfigStore();
