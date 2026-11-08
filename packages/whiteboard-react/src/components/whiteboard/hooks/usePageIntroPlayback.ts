import type { RefObject } from 'react';
import type { PageIntro, PageIntroStatus, ResolvePageIntro } from '../utils/pageIntroPolicy';
import type { PageTransitionHandle } from '../WhiteboardCanvas';

import { useCallback, useEffect, useRef, useState } from 'react';

import { resolveIntroTimeoutMs, shouldPlayResolvedIntro } from '../utils/pageIntroPolicy';

export interface UsePageIntroPlaybackOptions {
  /** Host-supplied lookup of a page's intro clip. Absent = the feature is off. */
  resolvePageIntro?: ResolvePageIntro;
  /**
   * Bumped by the host when the set of available intros changed — e.g. the native renderer finished
   * a clip for a page that was ALREADY open (import lands on page 1 while page 1's clip is still
   * rendering). Re-resolves for the current page and plays if that visit has not played yet.
   */
  pageIntroVersion?: number;
  /**
   * The canvas's transition controls. The hook decides WHICH transition a page gets; the canvas
   * draws it. Absent (or empty) = transitions are skipped and a clip simply plays.
   */
  transitionHandleRef?: RefObject<PageTransitionHandle | null>;
}

export interface UsePageIntroPlaybackResult {
  /** Attach to the hidden `<video>`; the background painter draws its frames. */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** True from the moment playback is started until `ended` / error / page change / timeout. */
  isPlaying: boolean;
  /**
   * Call on every page ENTER (the `loadPage` success path). Stable identity.
   *
   * `isForward` means the teacher stepped to the NEXT page, the only navigation PowerPoint plays a
   * transition for. A jump, a step backward and a board opening all enter without one.
   */
  enterPage: (pageId: string, options?: { isForward?: boolean }) => void;
  /**
   * Stop whatever is playing and settle the layer back to the static raster. Stable identity.
   * Used by the publish/export sweeps, which cycle other pages through the live canvas: a clip left
   * running would paint the page the teacher LEFT over the page the sweep just loaded.
   */
  stopPlayback: () => void;
  /** The current page's intro state, published on the canvas wrapper as `data-page-intro`. */
  status: PageIntroStatus;
  /** The page `status` describes, published as `data-page-intro-page`. */
  statusPageId: string | null;
}

/**
 * Plays a page's slide intro once per page ENTER.
 *
 * The clip itself is never mounted as a visible element: the video is a hidden, muted decoder whose
 * frames {@link WhiteboardCanvas} blits into the page-background layer with the same geometry the
 * static page raster uses, so the ink canvas above stays fully interactive while it runs.
 *
 * Staleness is handled with a per-ENTER visit token: a resolution that lands after the teacher moved
 * on (or after this visit already played) is dropped, never played over the wrong page.
 */
export function usePageIntroPlayback({
  pageIntroVersion,
  resolvePageIntro,
  transitionHandleRef,
}: UsePageIntroPlaybackOptions): UsePageIntroPlaybackResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // Observable state for e2e (and for reading a bug report): a handful of transitions per page, not
  // a per-frame signal — the frame pump lives entirely outside React.
  const [status, setStatus] = useState<PageIntroStatus>('none');
  const [statusPageId, setStatusPageId] = useState<string | null>(null);

  // The page currently ENTERED and the token of that entry. A re-entry of the same id is a new visit.
  const currentPageIdRef = useRef<string | null>(null);
  const visitRef = useRef(0);
  // The visit whose intro has been COMMITTED to — a transition begun, a clip started, or both.
  // Compared against `visitRef` for "this visit has already been handled".
  const playedVisitRef = useRef<number | null>(null);
  // The visit whose clip has actually been handed to the video element. Separate from the above
  // because a native transition claims the visit well before its clip starts playing.
  const startedVisitRef = useRef<number | null>(null);
  // Whether the CURRENT visit was a forward step, which is the only kind that gets a transition.
  const isForwardVisitRef = useRef(false);
  /**
   * Bumped by every stop. A transition's completion callback captures the value at the moment it
   * began, so a movement that is cancelled by a stop — a publish sweep, for one — cannot come back
   * afterwards and start the clip it was going to lead into.
   */
  const stopEpochRef = useRef(0);

  const resolveRef = useRef<ResolvePageIntro | undefined>(resolvePageIntro);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  // Whether the current run ever reached a decoded frame. A clip that never started (autoplay
  // refused, undecodable source) settles back to `none`, not `done` — nothing was shown.
  const startedRef = useRef(false);
  // A clip resolved while the window was hidden: held until the document becomes visible again.
  const deferredRef = useRef<{ intro: PageIntro; startAtMs: number; visit: number } | null>(null);

  resolveRef.current = resolvePageIntro;

  const stop = useCallback(() => {
    startedRef.current = false;
    stopEpochRef.current += 1;
    deferredRef.current = null;

    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    detachRef.current?.();
    detachRef.current = null;

    const video = videoRef.current;

    if (video) {
      try {
        video.pause();
      } catch {
        // A video that never started throws nothing worth reporting.
      }

      // The blob URL belongs to the HOST (it revokes it); only the attachment is dropped here.
      video.removeAttribute('src');
      video.load();
    }

    setIsPlaying(false);
  }, []);

  const startPlayback = useCallback(
    (intro: PageIntro, visit: number, startAtMs = 0) => {
      const video = videoRef.current;

      // Two resolutions for one visit (page enter + a version bump) can land back to back; the first
      // to reach here owns the visit.
      if (!video || !intro.url || visit !== visitRef.current || startedVisitRef.current === visit) {
        // No decoder to play it on: settle rather than leave the page reading `loading` forever.
        if (!video && visit === visitRef.current) setStatus('none');

        return;
      }

      playedVisitRef.current = visit;
      startedVisitRef.current = visit;
      startedRef.current = false;

      const finish = () => {
        // Only the run that is still current may tear down — a `stop()` from a page switch has
        // already handed the layer to the next page.
        if (visit !== visitRef.current) return;

        setStatus(startedRef.current ? 'done' : 'none');
        stop();
      };
      // The first frame is on screen: everything before this is still `loading`, so a test that
      // waits for `playing` is waiting for pixels, not for an intention to play.
      const onPlaying = () => {
        if (visit !== visitRef.current) return;

        startedRef.current = true;
        setStatus('playing');
      };

      // Entering a page whose clip OPENS with its transition, by any route other than stepping
      // forward, skips straight past that opening: the transition is for the step that was not
      // taken, and replaying it would animate in a page that is already on screen.
      const onLoadedMetadata = () => {
        if (visit !== visitRef.current) return;

        try {
          video.currentTime = startAtMs / 1_000;
        } catch {
          // A container that refuses the seek just plays from the top; the animations still run.
        }
      };

      video.addEventListener('ended', finish, { once: true });
      video.addEventListener('error', finish, { once: true });
      video.addEventListener('playing', onPlaying);

      if (startAtMs > 0) {
        video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
      }

      detachRef.current = () => {
        video.removeEventListener('ended', finish);
        video.removeEventListener('error', finish);
        video.removeEventListener('playing', onPlaying);
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
      };

      // Assigning `src` resets the element to the start of the new resource; touching currentTime
      // before any metadata exists is at best a no-op and at worst an InvalidStateError.
      video.src = intro.url;
      // Painting starts now: the draw loop falls back to the static raster until the first frame is
      // decoded, so nothing flashes while the clip spins up.
      setIsPlaying(true);
      timeoutRef.current = setTimeout(finish, resolveIntroTimeoutMs(intro.durationMs));

      void video.play().catch(() => {
        // Autoplay refused (or the source is undecodable): fall straight back to the raster.
        finish();
      });
    },
    [stop],
  );

  const playWhenVisible = useCallback(
    (intro: PageIntro, visit: number, startAtMs = 0) => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        startPlayback(intro, visit, startAtMs);

        return;
      }

      // Autoplay in a hidden window is throttled and would burn the clip against a page nobody sees.
      deferredRef.current = { intro, startAtMs, visit };
    },
    [startPlayback],
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') return;

      const deferred = deferredRef.current;

      if (!deferred) return;
      deferredRef.current = null;

      if (deferred.visit !== visitRef.current || startedVisitRef.current === deferred.visit) return;

      startPlayback(deferred.intro, deferred.visit, deferred.startAtMs);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [startPlayback]);

  const requestIntro = useCallback(
    async (pageId: string, visit: number) => {
      const resolve = resolveRef.current;

      if (!resolve) return;

      let intro: PageIntro | null = null;

      try {
        intro = await resolve(pageId);
      } catch {
        if (visit === visitRef.current) {
          setStatus('none');
          transitionHandleRef?.current?.cancel();
        }

        return;
      }

      // A page with neither a clip nor a transition has nothing to do.
      if (!intro || (!intro.url && !intro.transition)) {
        if (visit === visitRef.current) {
          setStatus('none');
          transitionHandleRef?.current?.cancel();
        }

        return;
      }

      const allowed = shouldPlayResolvedIntro({
        currentPageId: currentPageIdRef.current,
        currentVisit: visitRef.current,
        playedThisVisit: playedVisitRef.current === visitRef.current,
        requestedPageId: pageId,
        requestedVisit: visit,
      });

      if (!allowed) {
        // A resolution dropped because the teacher moved on says nothing about the page now open.
        if (visit === visitRef.current && playedVisitRef.current !== visit) {
          setStatus('none');
          transitionHandleRef?.current?.cancel();
        }

        return;
      }

      const handle = transitionHandleRef?.current ?? null;
      // A transition belongs to the STEP, not to the page: only a forward step plays one.
      const transition = isForwardVisitRef.current ? intro.transition : undefined;

      const epoch = stopEpochRef.current;

      if (transition && !transition.inClip && handle) {
        // Drawn here, from a snapshot of the page being left. The clip, if there is one, is the
        // slide's own animations and runs once the movement has finished — the order PowerPoint
        // plays them in.
        playedVisitRef.current = visit;
        setStatus('transition');
        handle.begin({
          direction: transition.direction,
          durationMs: transition.durationMs,
          kind: transition.kind,
          mode: 'native',
          orient: transition.orient,
          onDone: () => {
            // The visit alone is not enough: a publish sweep stops playback without changing the
            // page, so the movement it cancels must not lead into a clip mid-sweep.
            if (visit !== visitRef.current || epoch !== stopEpochRef.current) return;

            if (intro.url) {
              playWhenVisible(intro, visit);
            } else {
              setStatus('none');
            }
          },
          option: transition.option,
        });

        return;
      }

      if (transition && transition.inClip && intro.url && handle) {
        // The clip opens with the transition. Hold the outgoing page until its first frame exists,
        // so the new page never flashes up before its own transition has played.
        playedVisitRef.current = visit;
        handle.begin({ durationMs: transition.durationMs, mode: 'hold' });
        playWhenVisible(intro, visit);

        return;
      }

      // Nothing to animate into this page: release whatever the capture is holding and, if there is
      // a clip, play it. A clip that OPENS with a transition is entered past that opening, because
      // this is not the step the transition was authored for.
      handle?.cancel();

      if (!intro.url) {
        setStatus('none');

        return;
      }

      playedVisitRef.current = visit;
      playWhenVisible(intro, visit, intro.transition?.inClip ? intro.transition.durationMs : 0);
    },
    [playWhenVisible, transitionHandleRef],
  );

  const enterPage = useCallback(
    (pageId: string, options?: { isForward?: boolean }) => {
      const isForward = options?.isForward === true;

      currentPageIdRef.current = pageId;
      visitRef.current += 1;
      isForwardVisitRef.current = isForward;
      // Whatever the previous page was playing belongs to the previous page.
      stop();

      // A forward step has already re-armed the canvas by capturing the page being left, so
      // cancelling here would throw that capture away. Any other entry has no capture of its own,
      // so a transition still running belongs to an older page and must go.
      if (!isForward) {
        transitionHandleRef?.current?.cancel();
      }

      setStatusPageId(pageId);
      setStatus(resolveRef.current ? 'loading' : 'none');

      if (!resolveRef.current) {
        transitionHandleRef?.current?.cancel();

        return;
      }

      void requestIntro(pageId, visitRef.current);
    },
    [requestIntro, stop, transitionHandleRef],
  );

  /**
   * Everything off: the clip AND any transition in flight, with the ink handed back.
   *
   * The publish and export sweeps call this before cycling pages through the live canvas. Stopping
   * only the video would leave the canvas mid-movement with the ink hidden, and the movement's own
   * completion would then start the clip in the middle of the sweep.
   */
  const stopPlayback = useCallback(() => {
    stop();
    transitionHandleRef?.current?.cancel();
  }, [stop, transitionHandleRef]);

  // A new clip became available for a page that is ALREADY open.
  useEffect(() => {
    if (pageIntroVersion === undefined) return;

    const pageId = currentPageIdRef.current;

    if (!pageId || !resolveRef.current) return;
    if (playedVisitRef.current === visitRef.current) return;

    setStatus('loading');
    void requestIntro(pageId, visitRef.current);
  }, [pageIntroVersion, requestIntro]);

  useEffect(() => stop, [stop]);

  return { enterPage, isPlaying, status, statusPageId, stopPlayback, videoRef };
}
