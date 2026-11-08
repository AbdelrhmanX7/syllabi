/**
 * Decide which pointer samples a low-latency brush should replay for a single `pointermove`.
 *
 * A pen digitizer typically reports at 120–240 Hz while the compositor only fires one
 * `pointermove` per animation frame (~60 Hz). The browser buffers the samples it captured
 * between frames; `PointerEvent.getCoalescedEvents()` returns every one of them, with the
 * dispatched event itself as the final entry. The default Fabric pipeline keeps only that last
 * entry and discards the rest, which visibly facets fast curves and adds up to a frame of
 * perceived lag. Replaying every real sample reconstructs the true pen path — smoother strokes
 * AND lower perceived latency — with no speculative points, so it cannot create prediction
 * artifacts.
 *
 * This helper is deliberately free of any `fabric` import so it can be unit-tested in plain Node.
 *
 * This used to refuse to return anything for a brush that repaints its whole stroke each frame, on the
 * grounds that N samples would mean N full repaints. That is no longer the caller's behaviour: a
 * full-render brush now ACCUMULATES the intermediate samples and repaints once for the frame, so it
 * gets the accurate path at the cost of a single render. The old gate meant the calligraphy and marker
 * nibs — both full-render — silently threw away every sub-frame sample the digitizer produced.
 *
 * @param event the DOM event from Fabric's `onMouseMove` options (`{ e }`)
 * @returns the coalesced samples to replay, or `null` to use the default single-sample behavior.
 */
export function selectCoalescedSamples(
  event: { getCoalescedEvents?: () => PointerEvent[] } | null | undefined,
): PointerEvent[] | null {
  if (!event || typeof event.getCoalescedEvents !== 'function') {
    return null;
  }

  let samples: PointerEvent[];

  try {
    samples = event.getCoalescedEvents();
  } catch {
    return null;
  }

  if (!Array.isArray(samples) || samples.length <= 1) {
    return null;
  }

  return samples;
}

/** The subset of a pen sample this filter reads — a dispatched PointerEvent or one of its coalesced ones. */
export interface PenSampleLike {
  pointerType?: string;
  buttons?: number;
  pressure?: number;
}

/**
 * Per-contact memory for {@link classifyPenSample}: whether THIS contact has ever reported a positive
 * pressure. Pressure 0 only means "the tip is leaving" on a digitizer that reports pressure at all — one
 * that reports a flat 0 for its whole life (or 0 on its first frame, as some do while the tip is still
 * landing) must never have its samples dropped on that account.
 */
export interface PenContactPressureState {
  pressureSeen: boolean;
}

/**
 * What to do with one pen sample:
 *   - 'contact': the tip is down — append it.
 *   - 'skip':    the contact bit is still SET but the pen reports pressure 0 after real pressure — the
 *                tip is leaving and the digitizer is still tracking it. Do NOT append it (that is the
 *                "ink keeps going a few ms past the real lift" tail), but do NOT close the stroke either:
 *                a flaky pressure reading mid-letter must cost at most a skipped sample, never the rest
 *                of the letter (a closed stroke can only reopen on the next touchstart).
 *   - 'lift':    the contact bit is CLEAR — the tip switch opened. The only reading that closes a stroke.
 */
export type PenSampleVerdict = 'contact' | 'skip' | 'lift';

export function classifyPenSample(sample: PenSampleLike, state: PenContactPressureState): PenSampleVerdict {
  const { buttons, pressure } = sample;

  if (typeof buttons === 'number' && (buttons & 1) === 0) {
    return 'lift';
  }

  if (sample.pointerType === 'pen' && typeof pressure === 'number') {
    if (pressure > 0) {
      state.pressureSeen = true;
    } else if (pressure === 0 && state.pressureSeen) {
      return 'skip';
    }
  }

  return 'contact';
}

export interface PenFrameSplit {
  /** Indices of the samples that are in contact and precede any lift — the ones safe to append. */
  contactIndices: number[];
  /** 'lift' when any sample lifted (the stroke closes at the last contact sample before it); otherwise the
   *  verdict of the LAST sample — the dispatched event, the one Fabric itself is about to append. */
  verdict: PenSampleVerdict;
}

/**
 * Classify every sample of one pen frame (coalesced samples, dispatched event last). Predicted samples
 * (`getPredictedEvents`) are never part of the input: nothing here or in the brushes reads them.
 */
export function splitPenFrame(samples: readonly PenSampleLike[], state: PenContactPressureState): PenFrameSplit {
  const contactIndices: number[] = [];
  let verdict: PenSampleVerdict = 'contact';

  for (let index = 0; index < samples.length; index += 1) {
    verdict = classifyPenSample(samples[index], state);

    if (verdict === 'lift') {
      break;
    }

    if (verdict === 'contact') {
      contactIndices.push(index);
    }
  }

  return { contactIndices, verdict };
}
