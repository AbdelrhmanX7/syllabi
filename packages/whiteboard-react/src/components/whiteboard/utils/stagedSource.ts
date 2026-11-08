/**
 * Bookkeeping for a STAGED artefact that costs real disk until someone says otherwise — the PDF a
 * PowerPoint was converted into for the import modal. Converting a 73 MB deck writes a temp file;
 * if the teacher then cancels the modal, nobody ever tells the shell to delete it, and it sits
 * there until the next restart plus a day of cleanup.
 *
 * The rule is "exactly once": the staged value is either CONSUMED (the import took it, so its
 * lifetime belongs to the import now) or RELEASED (it left without being used, so it must be
 * discarded) — never both, and never twice. That is easy to get wrong across a modal's close
 * effect, its unmount and a second file pick all racing to clean up, so it lives here, free of
 * React, where it can be tested directly.
 *
 * Generic over the staged value so the test does not need a DOM `File`.
 */
export interface StagedSourceTracker<T> {
  /** Stage a new value. Anything already staged left without being used, so it is released first. */
  stage: (value: T) => void;
  /** The staged value was taken by whoever needed it: drop it WITHOUT discarding. */
  consume: () => void;
  /** The staged value is leaving unused: discard it, once. A no-op when nothing is staged. */
  release: () => void;
  /** What is staged right now, or null. */
  peek: () => T | null;
}

export function createStagedSourceTracker<T>(onDiscard: (value: T) => void): StagedSourceTracker<T> {
  let staged: T | null = null;

  const release = () => {
    if (staged === null) return;

    const leaving = staged;

    // Cleared BEFORE the callback: a handler that re-enters (closing a modal from inside a discard,
    // say) must not see the value still staged and discard it a second time.
    staged = null;
    onDiscard(leaving);
  };

  return {
    consume: () => {
      staged = null;
    },
    peek: () => staged,
    release,
    stage: (value: T) => {
      if (staged === value) return;

      release();
      staged = value;
    },
  };
}
