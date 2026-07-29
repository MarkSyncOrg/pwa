import { devices, expect, test } from '@playwright/test';

// The shell reflows down to phone widths on its own, so page scaling only ever
// leaves the user panning a half-offscreen UI. Three separate mechanisms keep it
// pinned at 1x — the viewport meta, `touch-action`, and 16px touch inputs — and
// each covers a browser the others do not, so each is asserted here. No login is
// needed: this is all app-shell chrome, present on the first paint.
test.describe('mobile layout stays fixed at 1x', () => {
  test.use({ ...devices['Pixel 7'] });

  test('viewport meta, touch-action and touch input size all pin the scale', async ({ page }) => {
    await page.goto('/');

    // Android/Chrome honours these two; iOS Safari has ignored them since iOS 10.
    const viewport = await page.getAttribute('meta[name=viewport]', 'content');
    expect(viewport).toContain('user-scalable=no');
    expect(viewport).toContain('maximum-scale=1');
    expect(viewport).toContain('width=device-width');

    // Drops pinch- and double-tap-zoom while leaving scrolling alone. The pan-y
    // half matters as much as the lock: without it the list stops scrolling.
    const touchAction = await page.evaluate(
      () => getComputedStyle(document.documentElement).touchAction,
    );
    expect(touchAction).toBe('pan-x pan-y');

    // iOS Safari zooms in on focus for any field under 16px and never zooms back
    // out — the one route to a scaled page the other two cannot block.
    const url = page.getByTestId('serviceUrl');
    await expect(url).toBeVisible();
    const fontSize = await url.evaluate((node) => getComputedStyle(node).fontSize);
    expect(fontSize).toBe('16px');

    // Nothing above is worth much if the shell itself overflows the phone: a
    // page that has to be panned sideways is the state zoom was papering over.
    // 1px of slack absorbs sub-pixel rounding at the device pixel ratio.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
