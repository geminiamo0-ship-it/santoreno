// #248: Dev-only authenticated Sheikh Chrome test; receives synthetic session
// cookie values through ephemeral runner process env, never logs or persists them.
import assert from "node:assert/strict";
import { openNoorStagingChrome, waitFor } from "../noor/scripts/chrome-local.mjs";

const origin = process.env.NOOR_STAGING_ORIGIN;
const teacher = JSON.parse(process.env.NOOR_SYNTHETIC_TEACHER_COOKIES || "[]");
const staff = JSON.parse(process.env.NOOR_SYNTHETIC_STAFF_COOKIES || "[]");
if (!Array.isArray(teacher) || !Array.isArray(staff) || !teacher.length || !staff.length) {
  throw new Error("Synthetic staging cookies unavailable");
}
const browser = await openNoorStagingChrome(origin);
async function setCookies(cookies) {
  await browser.send("Network.clearBrowserCookies");
  for (const cookie of cookies) {
    if (
      !cookie ||
      typeof cookie.name !== "string" ||
      typeof cookie.value !== "string" ||
      !cookie.name.length ||
      !cookie.value.length
    ) {
      throw new Error("Invalid synthetic session cookie");
    }
    const result = await browser.send("Network.setCookie", {
      url: origin,
      name: cookie.name,
      value: cookie.value,
      secure: true,
    });
    assert.notEqual(result.success, false, "Could not attach synthetic session");
  }
}
async function textIncludes(needle) {
  return browser.evaluate(
    `document.querySelector('#teacher-content')?.textContent.includes(${JSON.stringify(needle)})`,
  );
}
try {
  await browser.go("/teacher/students/");
  await waitFor(() => textIncludes("نظرة عامة"), "signed-out teacher public demo");
  const visitor = await browser.evaluate(
    "document.querySelector('[role=note]')?.textContent.includes('معاينة واجهة الشيخ')",
  );
  assert.equal(visitor, true, "Signed-out visitor lost original teacher preview");

  await setCookies(teacher);
  await browser.go("/teacher/students/");
  await waitFor(() => textIncludes("المتابعة الأكاديمية"), "connected teacher roster");
  await waitFor(() => textIncludes("Synthetic Learner 1"), "D1 assigned learner");
  await waitFor(() => textIncludes("Synthetic next memorization"), "D1 persisted plan");
  const connected = await browser.evaluate(
    "document.querySelector('[role=note]')?.textContent.includes('بوابة الشيخ المتصلة')",
  );
  assert.equal(connected, true, "Connected teacher mode did not activate");
  assert.equal(await textIncludes("المعاينة غير متصلة"), false);

  for (const [width, height] of [
    [360, 667],
    [390, 844],
    [768, 1024],
    [1280, 900],
    [1440, 900],
  ]) {
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 768,
    });
    const state = await browser.evaluate(
      "({rtl:document.documentElement.dir==='rtl',scroll:document.documentElement.scrollWidth,width:innerWidth})",
    );
    assert(state.rtl, "Connected Sheikh must remain RTL");
    assert(state.scroll <= state.width, "Teacher portal horizontal overflow " + width);
    await browser.screenshot("artifacts/noor-staging-teacher/students-" + width + ".png");
  }
  await setCookies(staff);
  await browser.go("/teacher/students/");
  await waitFor(() => textIncludes("غير مصرح بعرض بوابة الشيخ"), "staff-only is not teacher");
  assert.equal(await textIncludes("Synthetic Learner 1"), false, "Non-teacher sees real roster");
  assert.equal(await textIncludes("معاينة واجهة الشيخ"), false, "Non-teacher sees demo fallback");
  console.log(
    "PASS: Open Noor Sheikh demo for anonymous, connected D1 roster and plan for teacher, non-teacher denied, five responsive RTL viewports",
  );
} catch (error) {
  await browser.screenshot("artifacts/noor-staging-teacher/failure.png").catch(() => {});
  throw error;
} finally {
  await browser.close();
}
