import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AppConfig,
  AudioProcessInfo,
  DisplayInfo,
  RuntimeStatus,
  SourceLanguage,
  TargetLanguage,
} from '@shared/types';
import { t, type I18nKey } from '@shared/i18n';

const SOURCE_LANGUAGES: SourceLanguage[] = [
  'auto', 'zh', 'en', 'ja', 'ko', 'yue', 'de', 'fr', 'ru', 'es', 'it', 'pt', 'id', 'ar', 'th',
];
const TARGET_LANGUAGES: TargetLanguage[] = [
  'zh', 'en', 'ja', 'ko', 'yue', 'de', 'fr', 'ru', 'es', 'it', 'pt', 'id', 'ar', 'th',
];

/** Gummy ≈ ¥0.00015/s each for ASR and translation → ~0.0003/s combined. */
const PRICE_PER_SECOND = 0.00015 * 2;

export function Settings() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [processes, setProcesses] = useState<AudioProcessInfo[]>([]);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [processFilter, setProcessFilter] = useState('');
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail' | 'auth'>('idle');
  const [testDetail, setTestDetail] = useState('');

  const refreshProcesses = useCallback(() => {
    void window.gvs.listProcesses().then(setProcesses);
  }, []);

  useEffect(() => {
    void window.gvs.getConfig().then(setConfig);
    void window.gvs.getStatus().then(setStatus);
    void window.gvs.listDisplays().then(setDisplays);
    refreshProcesses();
    const offs = [window.gvs.onStatus(setStatus), window.gvs.onConfigChanged(setConfig)];
    return () => offs.forEach((off) => off());
  }, [refreshProcesses]);

  const lang = config?.uiLanguage ?? 'zh';
  const tr = useCallback((key: I18nKey, vars?: Record<string, string | number>) => t(lang, key, vars), [lang]);

  const update = useCallback((patch: Partial<AppConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
    void window.gvs.setConfig(patch);
  }, []);

  const filteredProcesses = useMemo(() => {
    const q = processFilter.trim().toLowerCase();
    return q ? processes.filter((p) => p.name.toLowerCase().includes(q)) : processes;
  }, [processes, processFilter]);

  const testConnection = useCallback(async () => {
    if (!config) return;
    setTestState('testing');
    const result = await window.gvs.testConnection(config.apiKey);
    setTestDetail(result.message);
    setTestState(result.ok ? 'ok' : result.authFailed ? 'auth' : 'fail');
  }, [config]);

  if (!config) return null;

  const usageSeconds = Math.round(status?.uploadedSecondsMonth ?? 0);
  const usageCost = (usageSeconds * PRICE_PER_SECOND).toFixed(2);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 text-sm">
      <div className="max-w-xl mx-auto p-5 space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">{tr('settingsTitle')}</h1>
          <ConnBadge status={status} tr={tr} />
        </header>

        {/* API */}
        <Section title={tr('secApi')}>
          <Row label={tr('apiKey')}>
            <div className="flex gap-2 w-full">
              <input
                type="password"
                className={inputCls + ' flex-1'}
                placeholder={tr('apiKeyPlaceholder')}
                value={config.apiKey}
                onChange={(e) => update({ apiKey: e.target.value })}
              />
              <button className={btnCls} disabled={testState === 'testing'} onClick={() => void testConnection()}>
                {testState === 'testing' ? tr('testing') : tr('testConnection')}
              </button>
            </div>
          </Row>
          {testState === 'ok' && <Hint color="text-green-400">{tr('testOk')}</Hint>}
          {testState === 'auth' && <Hint color="text-red-400">{tr('testFailAuth')}</Hint>}
          {testState === 'fail' && <Hint color="text-red-400">{`${tr('testFail')}: ${testDetail}`}</Hint>}
          <Hint color="text-slate-400">
            {tr('usageThisMonth')}: {tr('usageSecondsFmt', { s: usageSeconds, cost: usageCost })}
          </Hint>
        </Section>

        {/* Audio source */}
        <Section title={tr('secAudio')}>
          <Row label={tr('processLabel')}>
            <div className="flex flex-col gap-2 w-full">
              <div className="flex gap-2">
                <input
                  className={inputCls + ' flex-1'}
                  placeholder={tr('searchProcess')}
                  value={processFilter}
                  onChange={(e) => setProcessFilter(e.target.value)}
                />
                <button className={btnCls} onClick={refreshProcesses}>
                  {tr('refresh')}
                </button>
              </div>
              <select
                className={inputCls}
                value={config.captureProcessId ?? ''}
                onChange={(e) => {
                  const pid = e.target.value === '' ? null : Number(e.target.value);
                  const proc = processes.find((p) => p.pid === pid);
                  update({ captureProcessId: pid, captureProcessName: proc?.name ?? null });
                }}
              >
                <option value="">{tr('systemAudio')}</option>
                {filteredProcesses.map((p) => (
                  <option key={p.pid} value={p.pid}>
                    {p.name} (PID {p.pid})
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 text-slate-300">
                <input
                  type="checkbox"
                  checked={config.captureProcessTree}
                  onChange={(e) => update({ captureProcessTree: e.target.checked })}
                />
                {tr('includeTree')}
              </label>
            </div>
          </Row>
          {(config.captureProcessId === null || status?.capture === 'system') && (
            <Hint color="text-yellow-400">{tr('systemModeWarning')}</Hint>
          )}
          <Hint color="text-slate-500">{tr('platformWarning')}</Hint>
        </Section>

        {/* Languages */}
        <Section title={tr('secLanguage')}>
          <Row label={tr('engineLabel')}>
            <select
              className={inputCls}
              value={config.asrEngine}
              onChange={(e) => update({ asrEngine: e.target.value as AppConfig['asrEngine'] })}
            >
              <option value="paraformer">{tr('engineParaformer')}</option>
              <option value="gummy">{tr('engineGummy')}</option>
            </select>
          </Row>
          {config.asrEngine === 'paraformer' && (
            <Hint color="text-slate-400">{tr('engineParaformerHint')}</Hint>
          )}
          <Row label={tr('sourceLanguage')}>
            <select
              className={inputCls}
              value={config.sourceLanguage}
              onChange={(e) => update({ sourceLanguage: e.target.value as SourceLanguage })}
            >
              {SOURCE_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l === 'auto' ? tr('autoDetect') : l}
                </option>
              ))}
            </select>
          </Row>
          <Row label={tr('targetLanguage')}>
            <select
              className={inputCls}
              value={config.targetLanguage}
              onChange={(e) => update({ targetLanguage: e.target.value as TargetLanguage })}
            >
              {TARGET_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Row>
        </Section>

        {/* Display */}
        <Section title={tr('secDisplay')}>
          <Row label={`${tr('fontSize')} (${config.fontSize}px)`}>
            <input
              type="range"
              min={16}
              max={56}
              value={config.fontSize}
              className="w-full"
              onChange={(e) => update({ fontSize: Number(e.target.value) })}
            />
          </Row>
          <Row label={tr('position')}>
            <div className="flex gap-2 items-center w-full">
              <select
                className={inputCls}
                value={config.position}
                onChange={(e) => update({ position: e.target.value as AppConfig['position'] })}
              >
                <option value="top">{tr('posTop')}</option>
                <option value="middle">{tr('posMiddle')}</option>
                <option value="bottom">{tr('posBottom')}</option>
              </select>
              <button className={btnCls} onClick={() => void window.gvs.setEditMode(true)}>
                {tr('editPosition')}
              </button>
            </div>
          </Row>
          <Row label={`${tr('verticalOffset')} (${config.verticalOffsetPct.toFixed(0)})`}>
            <input
              type="range"
              min={-50}
              max={50}
              value={config.verticalOffsetPct}
              className="w-full"
              onChange={(e) => update({ verticalOffsetPct: Number(e.target.value) })}
            />
          </Row>
          <Row label={`${tr('bgOpacity')} (${Math.round(config.backgroundOpacity * 100)}%)`}>
            <input
              type="range"
              min={0}
              max={100}
              value={config.backgroundOpacity * 100}
              className="w-full"
              onChange={(e) => update({ backgroundOpacity: Number(e.target.value) / 100 })}
            />
          </Row>
          <Row label={tr('maxEntries')}>
            <input
              type="number"
              min={1}
              max={10}
              className={inputCls}
              value={config.maxEntries}
              onChange={(e) => update({ maxEntries: Math.max(1, Number(e.target.value) || 1) })}
            />
          </Row>
          <Row label={tr('ttlSeconds')}>
            <input
              type="number"
              min={2}
              max={60}
              className={inputCls}
              value={config.entryTtlSeconds}
              onChange={(e) => update({ entryTtlSeconds: Math.max(2, Number(e.target.value) || 8) })}
            />
          </Row>
          <Row label={tr('showSource')}>
            <input
              type="checkbox"
              checked={config.showSourceText}
              onChange={(e) => update({ showSourceText: e.target.checked })}
            />
          </Row>
          {displays.length > 1 && (
            <Row label={tr('display')}>
              <select
                className={inputCls}
                value={config.displayId ?? ''}
                onChange={(e) => update({ displayId: e.target.value === '' ? null : Number(e.target.value) })}
              >
                <option value="">{tr('primaryDisplay')}</option>
                {displays.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label} ({d.bounds.width}×{d.bounds.height}){d.primary ? ' ★' : ''}
                  </option>
                ))}
              </select>
            </Row>
          )}
        </Section>

        {/* Hotkeys */}
        <Section title={tr('secHotkeys')}>
          <Row label={tr('hotkeyToggle')}>
            <input
              className={inputCls}
              value={config.hotkeyToggleOverlay}
              onChange={(e) => update({ hotkeyToggleOverlay: e.target.value })}
            />
          </Row>
          <Row label={tr('hotkeyPause')}>
            <input
              className={inputCls}
              value={config.hotkeyTogglePause}
              onChange={(e) => update({ hotkeyTogglePause: e.target.value })}
            />
          </Row>
        </Section>

        {/* VAD */}
        <Section title={tr('secVad')}>
          <Row label={`${tr('vadSensitivity')} (${Math.round(config.vadSensitivity * 100)}%)`}>
            <input
              type="range"
              min={0}
              max={100}
              value={config.vadSensitivity * 100}
              className="w-full"
              onChange={(e) => update({ vadSensitivity: Number(e.target.value) / 100 })}
            />
          </Row>
        </Section>

        {/* Misc */}
        <Section title={tr('secMisc')}>
          <Row label={tr('uiLanguage')}>
            <select
              className={inputCls}
              value={config.uiLanguage}
              onChange={(e) => update({ uiLanguage: e.target.value as 'zh' | 'en' })}
            >
              <option value="zh">简体中文</option>
              <option value="en">English</option>
            </select>
          </Row>
          <Row label={tr('autoLaunch')}>
            <input
              type="checkbox"
              checked={config.autoLaunch}
              onChange={(e) => update({ autoLaunch: e.target.checked })}
            />
          </Row>
          <Row label={tr('debugLogging')}>
            <input
              type="checkbox"
              checked={config.debugLogging}
              onChange={(e) => update({ debugLogging: e.target.checked })}
            />
          </Row>
          <button className={btnCls} onClick={() => void window.gvs.openLogs()}>
            {tr('openLogs')}
          </button>
        </Section>
      </div>
    </div>
  );
}

const inputCls =
  'bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-slate-100 outline-none focus:border-blue-500 min-w-0';
const btnCls =
  'bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded px-3 py-1.5 text-white whitespace-nowrap';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-slate-800/50 rounded-lg p-4 space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-36 shrink-0 text-slate-300">{label}</div>
      {children}
    </div>
  );
}

function Hint({ color, children }: { color: string; children: React.ReactNode }) {
  return <p className={`text-xs ${color}`}>{children}</p>;
}

function ConnBadge({
  status,
  tr,
}: {
  status: RuntimeStatus | null;
  tr: (key: I18nKey) => string;
}) {
  const state = status?.connection ?? 'disconnected';
  const color =
    state === 'connected'
      ? 'bg-green-500'
      : state === 'error'
        ? 'bg-red-500'
        : state === 'disconnected'
          ? 'bg-slate-500'
          : 'bg-yellow-500';
  const key = `connState_${state}` as I18nKey;
  return (
    <span className="flex items-center gap-1.5 text-xs text-slate-300">
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
      {tr(key)}
    </span>
  );
}
