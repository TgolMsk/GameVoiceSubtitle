import { BrowserWindow, screen, shell } from 'electron';
import * as path from 'path';
import { IPC } from '@shared/types';
import { configStore } from '../store/config';
import { logger } from '../logger';

/**
 * Transparent, click-through, always-on-top subtitle overlay.
 *
 * Critical bits (breaking any of these breaks the whole product):
 *  - alwaysOnTop level 'screen-saver' so we sit above borderless-windowed games
 *  - setIgnoreMouseEvents(true, {forward: true}) for full click-through
 *  - focusable: false so the game never loses focus to us
 */
export class OverlayWindow {
  private win: BrowserWindow | null = null;
  private editMode = false;

  create(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;

    this.win = new BrowserWindow({
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      fullscreenable: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    this.win.setAlwaysOnTop(true, 'screen-saver'); // must be screen-saver level
    this.win.setIgnoreMouseEvents(true, { forward: true }); // full click-through
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.setMenuBarVisibility(false);

    this.win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });

    this.layout();

    if (process.env['ELECTRON_RENDERER_URL']) {
      void this.win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay/index.html`);
    } else {
      void this.win.loadFile(path.join(__dirname, '../renderer/overlay/index.html'));
    }

    this.win.once('ready-to-show', () => this.win?.showInactive());

    screen.on('display-metrics-changed', () => this.layout());
    screen.on('display-added', () => this.layout());
    screen.on('display-removed', () => this.layout());

    this.win.on('closed', () => {
      this.win = null;
    });

    logger.info('overlay window created');
    return this.win;
  }

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  /** Covers the work area of the configured display (or primary). */
  layout(): void {
    const win = this.window;
    if (!win) return;
    const config = configStore.get();
    const displays = screen.getAllDisplays();
    const display =
      displays.find((d) => d.id === config.displayId) ?? screen.getPrimaryDisplay();
    win.setBounds(display.workArea);
  }

  send(channel: string, payload: unknown): void {
    this.window?.webContents.send(channel, payload);
  }

  toggleVisible(): boolean {
    const win = this.window;
    if (!win) return false;
    if (win.isVisible()) {
      win.hide();
      return false;
    }
    win.showInactive();
    return true;
  }

  get isVisible(): boolean {
    return this.window?.isVisible() ?? false;
  }

  /**
   * Edit mode temporarily disables click-through so the user can drag the
   * subtitle block; the renderer reports the final position via config:set.
   */
  setEditMode(enabled: boolean): void {
    const win = this.window;
    if (!win) return;
    this.editMode = enabled;
    win.setIgnoreMouseEvents(!enabled, enabled ? undefined : { forward: true });
    // The window must be focusable while dragging, and never afterwards.
    win.setFocusable(enabled);
    if (enabled) win.focus();
    win.webContents.send(IPC.OverlayEditMode, enabled);
  }

  get isEditMode(): boolean {
    return this.editMode;
  }

  destroy(): void {
    this.win?.destroy();
    this.win = null;
  }
}
