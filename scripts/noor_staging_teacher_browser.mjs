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
async function presentAuthGate() {
  await waitFor(
    () => browser.evaluate("Boolean(document.querySelector('#account-form'))"),
    "signed-out Sheikh requires account login",
  );
}
async function textIncludes(needle) {
  return browser.evaluate(
    `document.querySelector('#teacher-content')?.textContent.includes(${JSON.stringify(needle)})`,
  );
}
try {
  await browser.go("/teacher/students/");
  await presentAuthGate();
  const anonymous = await browser.evaluate(
    "({demo:document.body.textContent.includes('معاينة واجهة الشيخ')," +
      "fixtures:document.body.textContent.includes('طالب تجريبي')," +
      "form:!!document.querySelector('#account-form')})",
  );
  assert.equal(anonymous.form, true, "Signed-out visitor must see real sign-in gate");
  assert.equal(anonymous.demo, false, "Signed-out visitor reached Sheikh fixture preview");
  assert.equal(anonymous.fixtures, false, "Signed-out visitor sees synthetic learners");

  await setCookies(teacher);
  await browser.go("/teacher/students/");
  await waitFor(() => textIncludes("المتابعة الأكاديمية"), "connected teacher roster");
  await waitFor(() => textIncludes("Synthetic Learner 1"), "D1 assigned learner");
  await waitFor(() => textIncludes("Synthetic next memorization"), "D1 persisted plan");
  const connected = await browser.evaluate(
    "document.querySelector('[role=note]')?.textContent.includes('بوابة الشيخ الموثقة')",
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
  const demoLinks = await browser.evaluate(
    "[...document.querySelectorAll('nav a')].filter(a=>new URL(a.href).pathname==='/classroom').length",
  );
  assert.equal(demoLinks, 0, "Real Sheikh sidebar must not link the classroom demo");

  await browser.go("/teacher/preparation/");
  await waitFor(() => textIncludes("التحضير للحصة"), "authenticated teacher preparation");
  assert.equal(await textIncludes("هذا القسم قيد ربط"), false, "Preparation still dummy fallback");

  await browser.go("/teacher/notifications/");
  await waitFor(() => textIncludes("سجل D1 الحقيقي"), "connected teacher inbox");
  // A heading renders before the signed GET finishes. Require the actual D1 read
  // to settle, and fail rather than silently accepting a server error or preview.
  await waitFor(
    () => textIncludes("غير مقروء:") || textIncludes("تعذّر تحميل الإشعارات من الخادم"),
    "signed teacher inbox D1 read",
  );
  assert.equal(await textIncludes("تعذّر تحميل الإشعارات من الخادم"), false,
    "Signed teacher inbox GET failed");
  assert.equal(await textIncludes("الإشعارات غير متصلة بعد"), false,
    "Connected teacher inbox fell back to historical placeholder");
  assert.equal(await textIncludes("إشعار تجريبي"), false, "Synthetic notification leaked");

  await browser.go("/teacher/cases/");
  await waitFor(() => textIncludes("سجل D1 موثّق"), "connected teacher attendance");
  await waitFor(
    () => textIncludes("سجل البلاغات المُرسلة") || textIncludes("خدمة الحضور غير متاحة"),
    "signed attendance cases D1 read",
  );
  assert.equal(await textIncludes("خدمة الحضور غير متاحة"), false,
    "Signed teacher attendance GET failed");
  assert.equal(await textIncludes("الحضور والبلاغات غير متصلة بعد"), false,
    "Connected attendance fell back to historical placeholder");
  assert.equal(await textIncludes("طالب تجريبي"), false, "Synthetic incident leaked");

  await setCookies(staff);
  await browser.go("/teacher/students/");
  await waitFor(() => textIncludes("غير مصرح بعرض بوابة الشيخ"), "staff-only is not teacher");
  assert.equal(await textIncludes("Synthetic Learner 1"), false, "Non-teacher sees real roster");
  assert.equal(await textIncludes("معاينة واجهة الشيخ"), false, "Non-teacher sees demo fallback");
  console.log(
    "PASS: Sheikh anonymous gate/no fixtures; connected D1 roster/preparation/inbox/attendance, non-teacher denied and five RTL viewports",
  );
} catch (error) {
  await browser.screenshot("artifacts/noor-staging-teacher/failure.png").catch(() => {});
  throw error;
} finally {
  await browser.close();
}
