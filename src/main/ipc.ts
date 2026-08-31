import { ipcMain, screen, shell } from 'electron';
import type { AppConfig, DisplayInfo, RuntimeStatus, TestConnectionResult } from '@shared/types';
import { IPC } from '@shared/types';
import { configStore } from './store/config';
import { listAudioProcesses } from './audio/capture';
import { testGummyConnection } from './asr/gummyClient';
import { logger } from './logger';

/** What the IPC layer needs from the app runtime (implemented in index.ts). */
export interface IpcContext {
  getStatus(): RuntimeStatus;
  togglePause(): void;
  toggleOverlay(): void;
  setEditMode(enabled: boolean): void;
  onApiKeyChanged(): void;
}

export function registerIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.ConfigGet, (): AppConfig => configStore.get());

  ipcMain.handle(IPC.ConfigSet, (_e, patch: Partial<AppConfig>): AppConfig => {
    // The renderer is sandboxed but still validate the shape loosely.
    if (typeof patch !== 'object' || patch === null) return configStore.get();
    const hadApiKey = 'apiKey' in patch;
    const config = configStore.set(patch);
    if (hadApiKey) ctx.onApiKeyChanged();
    return config;
  });

  ipcMain.handle(IPC.ProcessesList, () => listAudioProcesses());

  ipcMain.handle(IPC.ListDisplays, (): DisplayInfo[] => {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      label: d.label || `Display ${i + 1}`,
      bounds: d.bounds,
      primary: d.id === primaryId,
    }));
  });

  ipcMain.handle(IPC.StatusGet, () => ctx.getStatus());

  ipcMain.handle(IPC.TestConnection, async (_e, apiKey: string): Promise<TestConnectionResult> => {
    const result = await testGummyConnection(String(apiKey ?? ''));
    logger.info(`API key test: ok=${result.ok} authFailed=${result.authFailed}`);
    return result;
  });

  ipcMain.handle(IPC.SetEditMode, (_e, enabled: boolean) => ctx.setEditMode(Boolean(enabled)));
  ipcMain.handle(IPC.TogglePause, () => ctx.togglePause());
  ipcMain.handle(IPC.ToggleOverlay, () => ctx.toggleOverlay());
  ipcMain.handle(IPC.OpenLogs, () => shell.openPath(logger.dir));
}
