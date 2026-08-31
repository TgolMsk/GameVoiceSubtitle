import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Minimal daily-rolling file logger. No third-party deps.
 * Privacy rule: recognized/translated text and audio data are only logged at
 * `debug` level, and debug level is only enabled via the settings toggle.
 */
class Logger {
  private stream: fs.WriteStream | null = null;
  private currentDay = '';
  private debugEnabled = false;

  get dir(): string {
    return path.join(app.getPath('userData'), 'logs');
  }

  setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  private ensureStream(): fs.WriteStream {
    const day = new Date().toISOString().slice(0, 10);
    if (!this.stream || day !== this.currentDay) {
      this.stream?.end();
      fs.mkdirSync(this.dir, { recursive: true });
      this.stream = fs.createWriteStream(path.join(this.dir, `${day}.log`), { flags: 'a' });
      this.currentDay = day;
    }
    return this.stream;
  }

  private write(level: string, message: string): void {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
    try {
      this.ensureStream().write(line);
    } catch {
      // Logging must never crash the app.
    }
    if (!app.isPackaged) process.stdout.write(line);
  }

  info(message: string): void {
    this.write('INFO', message);
  }

  warn(message: string): void {
    this.write('WARN', message);
  }

  error(message: string): void {
    this.write('ERROR', message);
  }

  /** Only written when the user opted into debug logging (may contain recognized text). */
  debug(message: string): void {
    if (this.debugEnabled) this.write('DEBUG', message);
  }
}

export const logger = new Logger();
