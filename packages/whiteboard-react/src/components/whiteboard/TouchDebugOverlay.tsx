import React, { useEffect, useRef, useState } from 'react';

interface DebugPointer {
  id: number;
  type: string;
  width: number;
  height: number;
  pressure: number;
  x: number;
  y: number;
}

interface TouchDebugOverlayProps {
  enabled: boolean;
}

/**
 * Diagnostic-only overlay (off by default — gated by the "Touch diagnostics" setting). Shows live, RAW
 * (uncapped) pointer contacts so a panel's reported input can be inspected on-device:
 *  - a POSITIONAL marker at each contact (a ring sized to its reported width/height + a centre dot),
 *  - a text readout: contact count, each contact's type/size/pressure, and the max seen this session.
 *
 * It uses its OWN window-capture listeners (the gesture engine caps tracking at 2 contacts) and never
 * participates in gestures (pointerEvents:none).
 */
export function TouchDebugOverlay({ enabled }: TouchDebugOverlayProps): React.ReactElement | null {
  const pointersRef = useRef<Map<number, DebugPointer>>(new Map());
  const frameRef = useRef<number | null>(null);
  const [pointers, setPointers] = useState<DebugPointer[]>([]);
  const [maxContacts, setMaxContacts] = useState(0);
  const [maxSize, setMaxSize] = useState(0);

  useEffect(() => {
    if (!enabled) {
      pointersRef.current.clear();

      return;
    }

    // Fresh per-session readout each time it's switched on (don't carry stale max-seen values).
    pointersRef.current.clear();
    setPointers([]);
    setMaxContacts(0);
    setMaxSize(0);

    // Coalesce the React state push to one per animation frame — multiple contacts each fire their own
    // pointermove, so a setState per event would thrash while a whole hand is down.
    const scheduleSync = () => {
      if (frameRef.current !== null) return;

      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;

        const list = Array.from(pointersRef.current.values());

        setPointers(list);
        setMaxContacts((current) => Math.max(current, list.length));
        setMaxSize((current) => Math.max(current, ...list.map((p) => Math.max(p.width, p.height)), 0));
      });
    };

    const upsert = (event: PointerEvent) => {
      pointersRef.current.set(event.pointerId, {
        id: event.pointerId,
        type: event.pointerType,
        width: event.width,
        height: event.height,
        pressure: event.pressure,
        x: event.clientX,
        y: event.clientY,
      });
      scheduleSync();
    };

    const onDown = (event: PointerEvent) => upsert(event);
    const onMove = (event: PointerEvent) => {
      if (pointersRef.current.has(event.pointerId)) upsert(event);
    };
    const onEnd = (event: PointerEvent) => {
      pointersRef.current.delete(event.pointerId);
      scheduleSync();
    };

    window.addEventListener('pointerdown', onDown, { capture: true, passive: true });
    window.addEventListener('pointermove', onMove, { capture: true, passive: true });
    window.addEventListener('pointerup', onEnd, { capture: true });
    window.addEventListener('pointercancel', onEnd, { capture: true });

    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onEnd, true);
      window.removeEventListener('pointercancel', onEnd, true);

      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }

      pointersRef.current.clear();
    };
  }, [enabled]);

  if (!enabled) {
    return null;
  }

  return (
    <>
      {/* Positional layer: a marker at each contact, in fixed (screen) coords. */}
      <div dir='ltr' style={{ position: 'fixed', inset: 0, zIndex: 99998, pointerEvents: 'none' }}>
        {pointers.map((pointer) => {
          const ringSize = Math.max(16, Math.max(pointer.width, pointer.height));

          return (
            <React.Fragment key={pointer.id}>
              {/* Ring sized to the reported contact footprint. */}
              <div
                style={{
                  position: 'absolute',
                  left: pointer.x - ringSize / 2,
                  top: pointer.y - ringSize / 2,
                  width: ringSize,
                  height: ringSize,
                  border: '2px solid #ff4d6d',
                  borderRadius: '50%',
                  boxSizing: 'border-box',
                }}
              />
              {/* Exact contact point. */}
              <div
                style={{
                  position: 'absolute',
                  left: pointer.x - 3,
                  top: pointer.y - 3,
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: '#ff4d6d',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  left: pointer.x + 10,
                  top: pointer.y + 8,
                  font: '11px/1.3 ui-monospace, Menlo, Consolas, monospace',
                  color: '#fff',
                  background: 'rgba(0,0,0,0.7)',
                  padding: '1px 4px',
                  borderRadius: 4,
                  whiteSpace: 'nowrap',
                }}
              >
                #{pointer.id} {pointer.type} {Math.round(pointer.width)}×{Math.round(pointer.height)}
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* Text readout. */}
      <div
        dir='ltr'
        style={{
          position: 'fixed',
          top: 8,
          left: 8,
          zIndex: 99999,
          background: 'rgba(0,0,0,0.82)',
          color: '#22ff88',
          font: '12px/1.5 ui-monospace, Menlo, Consolas, monospace',
          padding: '8px 10px',
          borderRadius: 10,
          pointerEvents: 'none',
          maxWidth: '70vw',
          whiteSpace: 'pre',
        }}
      >
        <div>
          touches: <b style={{ color: '#fff' }}>{pointers.length}</b>
          {'  '}max#: <b style={{ color: '#ffd23f' }}>{maxContacts}</b>
          {'  '}maxSz: <b style={{ color: '#ffd23f' }}>{Math.round(maxSize)}</b>
        </div>
        {pointers.map((pointer) => (
          <div key={pointer.id}>
            #{pointer.id} {pointer.type} · {Math.round(pointer.width)}×{Math.round(pointer.height)} · p=
            {pointer.pressure.toFixed(2)}
          </div>
        ))}
        <div style={{ color: '#9aa' }}>raw pointer contacts (uncapped)</div>
      </div>
    </>
  );
}

export default TouchDebugOverlay;
