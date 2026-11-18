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
