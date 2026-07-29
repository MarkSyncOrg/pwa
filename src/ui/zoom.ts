/**
 * Pins the page at 1x on iOS.
 *
 * The viewport meta carries `user-scalable=no, maximum-scale=1` and styles.css
 * sets `touch-action: pan-x pan-y`; between them Android/Chrome is fully
 * covered. iOS Safari has deliberately ignored both since iOS 10, so pinch-zoom
 * still fires there and leaves the shell scaled and panned. What Safari does
 * still offer is the non-standard, cancellable `gesture*` events, so blocking
 * those — plus multi-touch `touchmove`, which some iOS versions zoom from even
 * with the gesture events cancelled — is the only lever left.
 *
 * Everything here is therefore gated on WebKit's `gesture*` support: on Chrome,
 * Firefox and every desktop browser nothing is attached at all, so no
 * scroll-blocking listener is added where CSS already does the job, and
 * ctrl+wheel and the browser's own zoom controls keep working.
 */
export function lockPageZoom(target: Document = document): () => void {
  const noop = (): void => {};
  // WebKit-only. Also the exact feature test that matters: where these events
  // do not exist, the CSS/meta route is honoured and this module is redundant.
  if (!('ongesturestart' in window)) {
    return noop;
  }

  const block = (event: Event): void => {
    if (event.cancelable) {
      event.preventDefault();
    }
  };

  // Only a genuine multi-touch gesture is swallowed; one-finger touchmove stays
  // untouched so the bookmark list still scrolls normally.
  const blockMultiTouch = (event: TouchEvent): void => {
    if (event.touches.length > 1) {
      block(event);
    }
  };

  // Safari only honours preventDefault on touchmove from a non-passive listener,
  // and it defaults to passive on document-level touch events.
  const passive = { passive: false } as const;

  target.addEventListener('gesturestart', block, passive);
  target.addEventListener('gesturechange', block, passive);
  target.addEventListener('gestureend', block, passive);
  target.addEventListener('touchmove', blockMultiTouch, passive);

  return () => {
    target.removeEventListener('gesturestart', block);
    target.removeEventListener('gesturechange', block);
    target.removeEventListener('gestureend', block);
    target.removeEventListener('touchmove', blockMultiTouch);
  };
}
