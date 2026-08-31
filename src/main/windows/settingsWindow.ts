import { BrowserWindow, shell } from 'electron';
import * as path from 'path';

/** Regular settings window; lazily created, hidden on close instead of destroyed. */
export class SettingsWindow {
  private win: BrowserWindow | null = null;

  show(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }
    this.win = new BrowserWindow({
      width: 560,
      height: 760,
      minWidth: 480,
      minHeight: 560,
      title: 'GameVoiceSubtitle',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    this.win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });

    if (process.env['ELECTRON_RENDERER_URL']) {
      void this.win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings/index.html`);
    } else {
      void this.win.loadFile(path.join(__dirname, '../renderer/settings/index.html'));
    }

    this.win.on('closed', () => {
      this.win = null;
    });
  }

  get currentWindow(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  send(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  destroy(): void {
    this.win?.destroy();
    this.win = null;
  }
}
