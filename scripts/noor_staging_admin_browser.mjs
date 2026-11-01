// #327: isolated Noor Admin Dev, synthetic cookies passed via ephemeral runner env.
// Never log/reuse cookies or screenshot teacher/learner private records.
import assert from "node:assert/strict";
import { openNoorStagingChrome, waitFor } from "../noor/scripts/chrome-local.mjs";

const origin = process.env.NOOR_STAGING_ORIGIN;
const staff = JSON.parse(process.env.NOOR_SYNTHETIC_STAFF_COOKIES || "[]");
const teacher = JSON.parse(process.env.NOOR_SYNTHETIC_TEACHER_COOKIES || "[]");
if (!origin || !staff.length || !teacher.length) {
  throw new Error("Signed synthetic Admin Dev sessions missing");
}
const browser = await openNoorStagingChrome(origin);

async function setCookies(cookies) {
  await browser.send("Network.clearBrowserCookies");
  for (const cookie of cookies) {
    if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string") {
      throw new Error("Invalid synthetic session cookie");
    }
    const response = await browser.send("Network.setCookie", {
      url: origin,
      name: cookie.name,
      value: cookie.value,
      secure: true,
    });
    assert.notEqual(response.success, false, "Synthetic signed session unavailable");
  }
}

async function pageIncludes(text) {
  return browser.evaluate(`document.body?.textContent.includes(${JSON.stringify(text)})`);
}
async function noOverview() {
  assert.equal(await pageIncludes("نظرة عامة على الأكاديمية"), false);
  assert.equal(await pageIncludes("مؤشرات من السجل الفعلي"), false);
  assert.equal(
    await browser.evaluate(
      "Boolean(document.querySelector('nav[aria-label=\"أقسام لوحة الإدارة\"]'))",
    ),
    false,
    "Denied user must not see administrative navigation",
  );
}

try {
  await browser.go("/admin/");
  await waitFor(
    () => browser.evaluate("Boolean(document.querySelector('#account-form'))"),
    "anonymous Admin sign-in gate",
  );
  await noOverview();

  await setCookies(teacher);
  await browser.go("/admin/");
  await waitFor(() => pageIncludes("غير مصرح بعرض لوحة الإدارة"), "Sheikh is not staff");
  await noOverview();

  await setCookies(staff);
  await browser.go("/admin/");
  await waitFor(() => pageIncludes("نظرة عامة على الأكاديمية"), "signed D1 Admin overview");
  await waitFor(() => pageIncludes("مؤشرات من السجل الفعلي"), "signed aggregate metrics");
  assert.equal(await pageIncludes("تعذّر تحميل البيانات الإدارية"), false);

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
      "({rtl:document.documentElement.dir==='rtl'," +
        "scroll:document.documentElement.scrollWidth,width:innerWidth," +
        "real:document.body.textContent.includes('نظرة عامة على الأكاديمية')})",
    );
    assert(state.rtl && state.real, "Admin signed RTL/overview missing");
    assert(state.scroll <= state.width, "Admin horizontal overflow " + width);
    await browser.screenshot("artifacts/noor-staging-admin/overview-" + width + ".png");
  }

  await browser.go("/admin/teachers/");
  await waitFor(
    () => pageIncludes("دليل شيوخ الأكاديمية"),
    "signed Admin Sheikh directory",
  );
  await waitFor(
    () => browser.evaluate("document.querySelectorAll('main article').length>0"),
    "actual signed D1 teacher list",
  );
  assert.equal(await pageIncludes("هذا القسم غير مفعل تشغيليًا"), false);
  assert.equal(await pageIncludes("السجل غير متاح الآن"), false);
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
      "({rtl:document.documentElement.dir==='rtl'," +
        "scroll:document.documentElement.scrollWidth,width:innerWidth," +
        "connected:document.querySelectorAll('main article').length>0})",
    );
    assert(state.rtl && state.connected, "Signed Sheikh directory missing");
    assert(state.scroll <= state.width, "Sheikh directory overflow " + width);
    await browser.screenshot("artifacts/noor-staging-admin/teachers-" + width + ".png");
  }
  assert.equal(await pageIncludes("تم اعتماد"), false, "Fake Admin activation");
  await browser.go("/admin/subscriptions/");
  await waitFor(
    () => pageIncludes("هذا القسم غير مفعل تشغيليًا"),
    "honest pending subscription section",
  );
  assert.equal(await pageIncludes("تم الدفع"), false, "Fake payment confirmation");

  await setCookies(teacher);
  await browser.go("/admin/teachers/");
  await waitFor(
    () => pageIncludes("غير مصرح بعرض لوحة الإدارة"),
    "signed Sheikh denied staff directory",
  );
  await noOverview();
  await browser.go("/admin/");
  await waitFor(() => pageIncludes("غير مصرح بعرض لوحة الإدارة"), "switch to denied role");
  await noOverview();

  console.log(
    "PASS: Noor Admin Dev overview and D1 Sheikh directory, signed roles and staff switch, five RTL viewports",
  );
} catch (error) {
  await browser.screenshot("artifacts/noor-staging-admin/failure.png").catch(() => {});
  throw error;
} finally {
  await browser.close();
}
