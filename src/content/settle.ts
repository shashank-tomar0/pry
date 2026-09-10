/**
 * Waiting for the page instead of waiting for the clock.
 *
 * Fixed sleeps are wrong in both directions at once: dead time on every
 * static step, and not nearly long enough on a cold Gmail compose mount.
 * Watching the DOM is faster in the common case and more patient in the
 * rare one. (Ported from the raidxAgent baseline's settle.ts, adapted.)
 *
 * No audio or persistent state: a MutationObserver plus timers, fully
 * torn down on resolve.
 */

/** How long to wait for the first sign of life before deciding there is none. */
const START_TIMEOUT = 250;

/** The grace a click gets, where a missed reaction is expensive. */
export const CLICK_CEILING = 900;

/** How still the DOM must be before we call it settled. */
const QUIET = 120;

/** The longest we will ever wait, however busy the page is. */
const CEILING = 3000;

/**
 * Resolves once the page stops changing, or once the ceiling is reached.
 * A page that never quiets down (clock, spinner, animated ad) hits the
 * ceiling and proceeds — permanent motion is not a reason to refuse to act.
 */
export function settle(options: { start?: number; quiet?: number; ceiling?: number } = {}): Promise<void> {
  const startTimeout = options.start ?? START_TIMEOUT;
  const quiet = options.quiet ?? QUIET;
  const ceiling = options.ceiling ?? CEILING;

  return new Promise<void>((resolve) => {
    let quietTimer = 0;
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(quietTimer);
      clearTimeout(ceilingTimer);
      observer.disconnect();
      // One frame, so anything the last mutation triggered has been laid out
      // before the caller measures the page.
      requestAnimationFrame(() => resolve());
    };

    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = self.setTimeout(finish, quiet);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    const ceilingTimer = self.setTimeout(finish, ceiling);

    // Nothing may ever happen — a click on an inert element, a scroll that
    // hits the end. Give the page a moment to react, then stop waiting.
    quietTimer = self.setTimeout(finish, startTimeout);
  });
}
