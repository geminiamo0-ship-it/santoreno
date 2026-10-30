// CR-02B3: two separately signed synthetic browsers, REAL LiveKit Cloud, fake media only.
import assert from "node:assert/strict";
import { openNoorStagingChrome, waitFor } from "../noor/scripts/chrome-local.mjs";

const origin = process.env.NOOR_STAGING_ORIGIN || "";
const lesson = process.env.NOOR_SYNTHETIC_LIVEKIT_LESSON || "";
const learner = process.env.NOOR_SYNTHETIC_LIVEKIT_LEARNER || "";
const teacherCookies = JSON.parse(process.env.NOOR_SYNTHETIC_TEACHER_COOKIES || "[]");
const studentCookies = JSON.parse(process.env.NOOR_SYNTHETIC_STUDENT_COOKIES || "[]");
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
if (
  process.env.NOOR_SYNTHETIC_LIVEKIT_QA !== "true" ||
  !/^https:\/\/noor-site-staging\.[a-z0-9-]+\.workers\.dev\/$/.test(origin) ||
  !uuid.test(lesson) ||
  !uuid.test(learner) ||
  !Array.isArray(teacherCookies) ||
  !Array.isArray(studentCookies) ||
  !teacherCookies.length ||
  !studentCookies.length
)
  throw Error("LiveKit QA requires isolated staging and ephemeral signed synthetic actors");

const teacher = await openNoorStagingChrome(origin, { syntheticMedia: true });
let student;
async function applyCookies(browser, cookies) {
  for (const cookie of cookies) {
    if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string")
      throw Error("Invalid synthetic session");
    const result = await browser.send("Network.setCookie", {
      url: origin,
      name: cookie.name,
      value: cookie.value,
      secure: true,
    });
    assert.notEqual(result.success, false, "Synthetic cookie rejected");
  }
}
const has = async (browser, text) =>
  browser.evaluate("document.body?.innerText.includes(" + JSON.stringify(text) + ")===true");
async function click(browser, label) {
  const expression =
    "(()=>{const b=[...document.querySelectorAll('button')].find(" +
    "x=>x.textContent.trim()===" +
    JSON.stringify(label) +
    " && !x.disabled" +
    ");if(!b)return false;b.click();return true})()";
  await waitFor(() => browser.evaluate(expression), "button " + label, 120);
}
const mediaReady = (browser) =>
  browser.evaluate(
    "!!document.querySelector('section[aria-label=\"الصوت والفيديو المباشر\"]')" +
      " && document.querySelector('section[aria-label=\"الصوت والفيديو المباشر\"]')" +
      ".textContent.includes('متصل بالصوت والفيديو')",
  );
const remoteVideoReady = (browser) =>
  browser.evaluate(
    "(()=>{const v=document.querySelector('[aria-label=\"فيديو الطرف الآخر\"] video');" +
      "return !!v&&v.readyState>=2&&v.videoWidth>0&&v.videoHeight>0&&" +
      "v.getBoundingClientRect().width>40&&v.getBoundingClientRect().height>40})()",
  );
const localVideoReady = (browser) =>
  browser.evaluate(
    "(()=>{const v=document.querySelector('[aria-label=\"معاينة كاميرتي\"] video');" +
      "return !!v&&v.readyState>=2&&v.videoWidth>0&&" +
      "v.getBoundingClientRect().width>40&&v.getBoundingClientRect().height>40})()",
  );
const remoteAudioExists = (browser) =>
  browser.evaluate("!!document.querySelector('[aria-label=\"صوت الطرف الآخر\"] audio')");
async function snapshot(browser, width, height, label) {
  await browser.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 768,
  });
  const result = await browser.evaluate(
    "({width:innerWidth,scroll:document.documentElement.scrollWidth})",
  );
  assert.equal(result.width, width, "Unexpected viewport");
  assert.ok(result.scroll <= width + 2, "Unexpected horizontal scrolling " + label);
  await browser.screenshot("artifacts/noor-staging-livekit/" + label + ".png");
}
try {
  student = await openNoorStagingChrome(origin, { syntheticMedia: true });
  await Promise.all([applyCookies(teacher, teacherCookies), applyCookies(student, studentCookies)]);
  await Promise.all([
    teacher.go("/classroom/live/?role=teacher&lessonId=" + encodeURIComponent(lesson)),
    student.go(
      "/classroom/live/?role=learner&lessonId=" +
        encodeURIComponent(lesson) +
        "&learnerId=" +
        encodeURIComponent(learner),
    ),
  ]);
  await Promise.all([
    waitFor(() => has(teacher, "الانضمام لغرفة الانتظار"), "signed teacher waiting room"),
    waitFor(() => has(student, "الانضمام لغرفة الانتظار"), "signed student waiting room"),
  ]);
  await click(teacher, "الانضمام لغرفة الانتظار");
  await click(student, "الانضمام لغرفة الانتظار");
  await Promise.all([
    waitFor(() => has(teacher, "دخول الصوت والفيديو"), "signed teacher media panel"),
    waitFor(() => has(student, "دخول الصوت والفيديو"), "signed student media panel"),
  ]);
  await Promise.all([click(teacher, "دخول الصوت والفيديو"), click(student, "دخول الصوت والفيديو")]);
  await Promise.all([
    waitFor(() => mediaReady(teacher), "teacher real LiveKit Cloud connected"),
    waitFor(() => mediaReady(student), "student real LiveKit Cloud connected"),
  ]);
  for (const browser of [teacher, student]) {
    assert.equal(await localVideoReady(browser), false, "Camera published without local opt-in");
    assert.equal(
      await remoteAudioExists(browser),
      false,
      "Microphone published without local opt-in",
    );
  }
  console.log("PASS: two signed synthetic browser actors connected to LiveKit with camera/mic OFF");

  await Promise.all([click(teacher, "تشغيل كاميرتي"), click(student, "تشغيل كاميرتي")]);
  await Promise.all([
    waitFor(() => localVideoReady(teacher), "teacher synthetic camera"),
    waitFor(() => localVideoReady(student), "student synthetic camera"),
    waitFor(() => remoteVideoReady(teacher), "teacher remote student video"),
    waitFor(() => remoteVideoReady(student), "student remote teacher video"),
  ]);
  await Promise.all([click(teacher, "تشغيل ميكروفوني"), click(student, "تشغيل ميكروفوني")]);
  await Promise.all([
    waitFor(() => remoteAudioExists(teacher), "teacher remote student audio"),
    waitFor(() => remoteAudioExists(student), "student remote teacher audio"),
  ]);
  await snapshot(teacher, 1280, 900, "teacher-desktop-1280");
  await snapshot(student, 390, 844, "student-mobile-390");
  await snapshot(student, 360, 667, "student-mobile-360");
  console.log(
    "PASS: bidirectional real WebRTC with synthetic A/V tracks and responsive screenshots",
  );

  await click(student, "إنهاء اتصال الصوت والفيديو");
  await waitFor(() => has(student, "دخول الصوت والفيديو"), "student media disconnect");
  await click(student, "دخول الصوت والفيديو");
  await waitFor(() => mediaReady(student), "student fresh signed WebRTC reconnect");
  console.log("PASS: student LiveKit media disconnect and reconnect");
  await click(student, "مغادرة غرفة الانتظار");
  await waitFor(() => has(student, "الانضمام لغرفة الانتظار"), "signed student DO leave");
  await click(teacher, "مغادرة غرفة الانتظار");
  await waitFor(() => has(teacher, "الانضمام لغرفة الانتظار"), "signed teacher DO leave");
  console.log("PASS: both signed DO leaves detached local A/V");
} catch (error) {
  await teacher.screenshot("artifacts/noor-staging-livekit/teacher-failure.png").catch(() => {});
  if (student)
    await student.screenshot("artifacts/noor-staging-livekit/student-failure.png").catch(() => {});
  // Never print session cookies, JWT, provider room or identity.
  throw Error("Two-browser LiveKit staging acceptance failed at a documented step");
} finally {
  await teacher.close();
  if (student) await student.close();
}
