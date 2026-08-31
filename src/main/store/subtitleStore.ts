import type { SubtitleEntry } from '@shared/types';
import type { GummyResultEvent } from '../asr/types';

/**
 * Merges streaming Gummy results into a small rolling list of subtitle entries.
 *
 * Same (taskId, sentence_id) → later results REPLACE the earlier text (partials
 * refine in place); `sentence_end: true` marks the entry final. Only the most
 * recent N entries are kept, and entries older than the TTL are evicted.
 */
export class SubtitleStore {
  private entries: SubtitleEntry[] = [];
  private maxEntries = 3;
  private ttlMs = 8000;
  private evictTimer: NodeJS.Timeout | null = null;

  constructor(private onUpdate: (entries: SubtitleEntry[]) => void) {}

  configure(maxEntries: number, ttlSeconds: number): void {
    this.maxEntries = Math.max(1, maxEntries);
    this.ttlMs = Math.max(1, ttlSeconds) * 1000;
    this.prune();
    this.emit();
  }

  applyResult(result: GummyResultEvent): void {
    const { taskId, transcription, translations } = result;
    const translation = translations?.[0];
    // A result may carry transcription only, translation only, or both.
    const sentenceId = transcription?.sentence_id ?? translation?.sentence_id;
    if (sentenceId === undefined) return;
    const id = `${taskId}:${sentenceId}`;

    let entry = this.entries.find((e) => e.id === id);
    if (!entry) {
      entry = {
        id,
        sentenceId,
        sourceText: '',
        translatedText: '',
        isFinal: false,
        createdAt: Date.now(),
      };
      this.entries.push(entry);
    }
    if (transcription) entry.sourceText = transcription.text;
    if (translation) entry.translatedText = translation.text;
    if (transcription?.sentence_end || translation?.sentence_end) entry.isFinal = true;

    this.prune();
    this.emit();
    this.scheduleEviction();
  }

  clear(): void {
    this.entries = [];
    this.emit();
  }

  private prune(): void {
    const now = Date.now();
    this.entries = this.entries.filter((e) => now - e.createdAt < this.ttlMs);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(this.entries.length - this.maxEntries);
    }
  }

  /** Re-emits after the oldest entry expires so faded-out lines disappear without new input. */
  private scheduleEviction(): void {
    if (this.evictTimer) clearTimeout(this.evictTimer);
    if (this.entries.length === 0) return;
    const oldest = this.entries[0];
    const delay = Math.max(50, oldest.createdAt + this.ttlMs - Date.now());
    this.evictTimer = setTimeout(() => {
      this.evictTimer = null;
      this.prune();
      this.emit();
      this.scheduleEviction();
    }, delay);
  }

  private emit(): void {
    // Full-list broadcast on purpose: payload is tiny, incremental sync is not worth it.
    this.onUpdate([...this.entries]);
  }
}
