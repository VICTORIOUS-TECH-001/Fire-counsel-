import { test, expect, expectNoHorizontalOverflow } from "./fixtures.mjs";

test("the responsive assertion rejects real overflow and accepts a fitting layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent('<!doctype html><html><body><div id="too-wide" style="width:1000px;height:30px">Overflow fixture</div></body></html>');
  // Exercise the same deadline/condition as app checks. It must fail, with the
  // offending element reported; no app CSS hides the intentionally wide box.
  await expect(expectNoHorizontalOverflow(page)).rejects.toThrow(/"element":"#too-wide"/);
  await page.locator("#too-wide").evaluate(element => { element.style.width = "100%"; });
  await expectNoHorizontalOverflow(page);
});

test("the responsive assertion observes a settled layout even when headless animation frames stop", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/layout-without-frames", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body>
    <div id="resizing" style="width:1000px;height:30px">Resize fixture</div>
    <script>window.requestAnimationFrame = () => 0;</script>
  </body></html>` }));
  await page.goto("/layout-without-frames");
  await page.evaluate(() => {
    const width = Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth").get;
    let first = true;
    Object.defineProperty(document.documentElement, "scrollWidth", { get() {
      const measured = width.call(this);
      // The first measurement sees genuine overflow, then the style settles.
      // This event-driven microtask models resize without a timed sleep or a
      // fake width, and no animation frame will deliver another measurement.
      if (first) { first = false; queueMicrotask(() => { document.getElementById("resizing").style.width = "100%"; }); }
      return measured;
    } });
  });
  await expectNoHorizontalOverflow(page);
});
