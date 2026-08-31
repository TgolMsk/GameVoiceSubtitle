import type { TargetLanguage } from '@shared/types';
import { logger } from '../logger';

/**
 * Sentence translator for the Paraformer path (Paraformer is ASR-only).
 *
 * Uses DashScope's OpenAI-compatible endpoint with qwen-mt-turbo: cheap
 * (~¥2 per million tokens), fast, and shares the same Bailian API key as ASR.
 * Only FINAL sentences are translated — partials would multiply cost and
 * flicker; the overlay shows the source text until the translation lands.
 */

const QWEN_MT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const QWEN_MT_MODEL = 'qwen-mt-turbo';
const TIMEOUT_MS = 8000;

/** qwen-mt takes English language names, not ISO codes. */
const LANG_NAMES: Record<TargetLanguage, string> = {
  zh: 'Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  yue: 'Cantonese',
  de: 'German',
  fr: 'French',
  ru: 'Russian',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  id: 'Indonesian',
  ar: 'Arabic',
  th: 'Thai',
};

function resolveUrl(): string {
  // Test-only override, mirroring GVS_GUMMY_URL.
  return process.env['GVS_QWEN_URL'] ?? QWEN_MT_URL;
}

export async function translateSentence(
  text: string,
  targetLanguage: TargetLanguage,
  apiKey: string,
): Promise<string | null> {
  if (!text.trim() || !apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(resolveUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: QWEN_MT_MODEL,
        messages: [{ role: 'user', content: text }],
        translation_options: {
          source_lang: 'auto',
          target_lang: LANG_NAMES[targetLanguage] ?? 'Chinese',
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn(`qwen-mt HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const translated = data.choices?.[0]?.message?.content;
    return typeof translated === 'string' && translated.trim() ? translated.trim() : null;
  } catch (err) {
    logger.warn(`qwen-mt request failed: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
