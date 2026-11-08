import React, { useCallback, useEffect, useState } from 'react';

import { getPerfEntries, getPerfReport, isPerfHudEnabled, subscribePerf, togglePerfHud } from './utils/perfHud';

/** Copy text to the clipboard, with a hidden-textarea fallback for WebViews that block the async API. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);

      return true;
    }
  } catch {
    // fall through to the legacy path
  }

  try {
    const textarea = document.createElement('textarea');

    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();

    const ok = document.execCommand('copy');

    textarea.remove();

    return ok;
  } catch {
    return false;
  }
}

/** Trigger a download of the report as a .json file (also a way to hand the data off). */
function downloadReport(text: string): void {
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = 'whiteboard-perf.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  } catch {
    // best effort
  }
}

const BUTTON_STYLE: React.CSSProperties = {
  pointerEvents: 'auto',
  cursor: 'pointer',
  border: '1px solid #3a3d44',
  borderRadius: 6,
  background: '#1c1e24',
  color: '#e8e8ea',
  font: 'inherit',
  padding: '1px 7px',
};

/**
 * On-screen performance HUD. Renders the recent timing samples recorded via {@link recordPerf}
 * (page-switch phases, ink reload, PDF image resolution) so the bottleneck is visible live on the
 * user's own device, and offers a one-click structured export (copy / save) to hand the data off.
 * Toggle with Ctrl/Cmd+Shift+D. Renders nothing when disabled.
 */
export default function PerfOverlay(): React.ReactElement | null {
  const [, forceRender] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setEnabled(isPerfHudEnabled());

    const unsubscribe = subscribePerf(() => {
      setEnabled(isPerfHudEnabled());
      forceRender((n) => n + 1);
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'D' || event.key === 'd')) {
        event.preventDefault();
        togglePerfHud();
        setEnabled(isPerfHudEnabled());
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      unsubscribe();
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const handleCopy = useCallback(() => {
    const report = getPerfReport();

    void copyToClipboard(report).then((ok) => {
      if (!ok) {
        downloadReport(report);
      }

      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }, []);

  const handleSave = useCallback(() => {
    downloadReport(getPerfReport());
  }, []);

  if (!enabled) {
    return null;
  }

  const entries = getPerfEntries();

  return (
    <div
      dir='ltr'
      style={{
        // Upper-left, clear of the page switcher (bottom-left) and the side buttons (left edge):
        // the owner could not turn pages with the panel parked in the corner (2026-09-13).
        position: 'fixed',
        top: 140,
        left: 84,
        zIndex: 2147483647,
        width: 340,
        maxHeight: '50vh',
        overflowY: 'auto',
        padding: '8px 10px',
        borderRadius: 10,
        background: 'rgba(12,13,16,0.93)',
        color: '#e8e8ea',
        font: '11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
        pointerEvents: 'none',
        userSelect: 'text',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ color: '#ffd166', fontWeight: 700, flex: 1 }}>⚡ Perf HUD</span>
        <button style={BUTTON_STYLE} type='button' onClick={handleCopy}>
          {copied ? 'copied ✓' : 'copy'}
        </button>
        <button style={BUTTON_STYLE} type='button' onClick={handleSave}>
          save
        </button>
      </div>
      <div style={{ color: '#8b8d93', marginBottom: 6 }}>Ctrl+Shift+D to hide</div>
      {entries.length === 0 ? (
        <div style={{ color: '#8b8d93' }}>switch a page to record…</div>
      ) : (
        entries.map((entry) => (
          <div
            key={entry.id}
            style={{ marginBottom: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            <span
              style={{ color: entry.ms >= 1000 ? '#ff6b6b' : entry.ms >= 300 ? '#ffd166' : '#7bd88f', fontWeight: 700 }}
            >
              {entry.ms}ms
            </span>{' '}
            <span style={{ color: '#cdd0d6' }}>{entry.label}</span>
            {entry.detail ? <span style={{ color: '#8b8d93' }}> · {entry.detail}</span> : null}
          </div>
        ))
      )}
    </div>
  );
}
