import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppConfig, RuntimeStatus, SubtitleEntry } from '@shared/types';
import { t } from '@shared/i18n';

const CONN_COLORS: Record<RuntimeStatus['connection'], string> = {
  connected: '#2ecc71',
  connecting: '#f1c40f',
  reconnecting: '#f1c40f',
  disconnected: '#95a5a6',
  error: '#e74c3c',
};

export function Overlay() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [entries, setEntries] = useState<SubtitleEntry[]>([]);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [meter, setMeter] = useState(0);
  const [editMode, setEditMode] = useState(false);

  useEffect(() => {
    void window.gvs.getConfig().then(setConfig);
    void window.gvs.getStatus().then(setStatus);
    const offs = [
      window.gvs.onSubtitles(setEntries),
      window.gvs.onStatus(setStatus),
      window.gvs.onMeter(setMeter),
      window.gvs.onEditMode(setEditMode),
      window.gvs.onConfigChanged(setConfig),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // ---- drag-to-reposition (edit mode only) --------------------------------
  const dragState = useRef<{ startY: number; startOffset: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!editMode || !config) return;
      dragState.current = { startY: e.clientY, startOffset: config.verticalOffsetPct };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [editMode, config],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragState.current || !config) return;
      const dyPct = ((e.clientY - dragState.current.startY) / window.innerHeight) * 100;
      const next = Math.max(-90, Math.min(90, dragState.current.startOffset + dyPct));
      setConfig({ ...config, verticalOffsetPct: next });
    },
    [config],
  );

  const onPointerUp = useCallback(() => {
    if (!dragState.current || !config) return;
    dragState.current = null;
    void window.gvs.setConfig({ verticalOffsetPct: config.verticalOffsetPct });
  }, [config]);

  if (!config) return null;
  const lang = config.uiLanguage;

  // Vertical anchor: top/middle/bottom + user offset (percent of screen height).
  const baseTopPct = config.position === 'top' ? 8 : config.position === 'middle' ? 45 : 82;
  const topPct = Math.max(0, Math.min(95, baseTopPct + config.verticalOffsetPct));

  const visible = entries.length > 0 || editMode;

  return (
    <div className="w-full h-full relative">
      {/* status pill: connection dot + voice indicator + mini volume meter */}
      <div className="absolute bottom-2 right-3 flex items-center gap-2 px-2 py-1 rounded-full bg-black/40">
        <span
          className="inline-block w-2.5 h-2.5 rounded-full"
          style={{ backgroundColor: CONN_COLORS[status?.connection ?? 'disconnected'] }}
          title={status?.connection}
        />
        {status?.paused && (
          <span className="text-[10px] text-yellow-300 subtitle-outline">{t(lang, 'paused')}</span>
        )}
        {status?.speaking && (
          <span className="text-[10px] text-green-300 subtitle-outline">{t(lang, 'speaking')}</span>
        )}
        <div className="w-14 h-1.5 bg-white/20 rounded overflow-hidden">
          <div
            className="h-full bg-green-400 transition-[width] duration-100"
            style={{ width: `${Math.min(100, meter * 300)}%` }}
          />
        </div>
      </div>

      {/* subtitle stack */}
      {visible && (
        <div
          className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 max-w-[80vw]"
          style={{ top: `${topPct}%`, pointerEvents: editMode ? 'auto' : 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {editMode && (
            <div className="px-4 py-2 rounded-lg bg-blue-600/80 text-white text-sm cursor-move text-center">
              {t(lang, 'editHint')}
              <button
                className="ml-3 px-2 py-0.5 rounded bg-white/20 hover:bg-white/40 cursor-pointer"
                onClick={() => void window.gvs.setEditMode(false)}
              >
                {t(lang, 'exitEdit')}
              </button>
            </div>
          )}
          {entries.map((entry) => (
            <SubtitleBlock key={entry.id} entry={entry} config={config} />
          ))}
          {editMode && entries.length === 0 && (
            <SubtitleBlock
              entry={{
                id: 'demo',
                sentenceId: 0,
                sourceText: "Let's rotate to B site.",
                translatedText: '我们转去 B 点。',
                isFinal: true,
                createdAt: Date.now(),
              }}
              config={config}
            />
          )}
        </div>
      )}
    </div>
  );
}

function SubtitleBlock({ entry, config }: { entry: SubtitleEntry; config: AppConfig }) {
  return (
    <div
      className="subtitle-enter px-4 py-1.5 rounded-lg text-center"
      style={{
        backgroundColor: `rgba(0, 0, 0, ${config.backgroundOpacity})`,
        opacity: entry.isFinal ? 1 : 0.75, // partials look "in progress"
      }}
    >
      {/* Two-line layout is the core UX: small gray source above, big white translation below. */}
      {config.showSourceText && entry.sourceText && (
        <div
          className="subtitle-outline text-gray-300 leading-snug"
          style={{ fontSize: `${Math.round(config.fontSize * 0.55)}px` }}
        >
          {entry.sourceText}
        </div>
      )}
      <div
        className="subtitle-outline text-white font-medium leading-snug"
        style={{ fontSize: `${config.fontSize}px` }}
      >
        {entry.translatedText || entry.sourceText}
      </div>
    </div>
  );
}
