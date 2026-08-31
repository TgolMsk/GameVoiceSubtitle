import { contextBridge, ipcRenderer } from 'electron';
import type { AppConfig, RendererApi, RuntimeStatus, SubtitleEntry } from '@shared/types';
import { IPC } from '@shared/types';

/** Subscribes to a broadcast channel; returns an unsubscribe function. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: RendererApi = {
  getConfig: () => ipcRenderer.invoke(IPC.ConfigGet),
  setConfig: (patch: Partial<AppConfig>) => ipcRenderer.invoke(IPC.ConfigSet, patch),
  listProcesses: () => ipcRenderer.invoke(IPC.ProcessesList),
  listDisplays: () => ipcRenderer.invoke(IPC.ListDisplays),
  getStatus: () => ipcRenderer.invoke(IPC.StatusGet),
  testConnection: (apiKey: string) => ipcRenderer.invoke(IPC.TestConnection, apiKey),
  setEditMode: (enabled: boolean) => ipcRenderer.invoke(IPC.SetEditMode, enabled),
  togglePause: () => ipcRenderer.invoke(IPC.TogglePause),
  toggleOverlay: () => ipcRenderer.invoke(IPC.ToggleOverlay),
  openLogs: () => ipcRenderer.invoke(IPC.OpenLogs),
  onSubtitles: (cb: (entries: SubtitleEntry[]) => void) => on(IPC.SubtitleUpdate, cb),
  onStatus: (cb: (status: RuntimeStatus) => void) => on(IPC.StatusUpdate, cb),
  onMeter: (cb: (level: number) => void) => on(IPC.MeterUpdate, cb),
  onEditMode: (cb: (enabled: boolean) => void) => on(IPC.OverlayEditMode, cb),
  onConfigChanged: (cb: (config: AppConfig) => void) => on(IPC.ConfigChanged, cb),
};

contextBridge.exposeInMainWorld('gvs', api);
