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
  // A default headless 780x490 viewport collapses the original teaching dock;
  // real acceptance starts at the explicitly approved role-specific viewports.
  await Promise.all([
    teacher.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    }),
    student.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    }),
  ]);
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
  // Owner QA #232: Sheikh may mute AND later release microphone moderation.
  // Student is never remotely activated; they opt back in after release.
  await click(teacher, "كتم ميكروفون الطالب");
  await waitFor(
    () => has(teacher, "إلغاء كتم الطالب"),
    "Sheikh moderation shows reversible state",
  );
  await waitFor(
    () => has(student, "الشيخ كتم ميكروفونك"),
    "Student observes teacher moderator lock",
  );
  await click(teacher, "إلغاء كتم الطالب");
  await waitFor(
    () => has(teacher, "كتم ميكروفون الطالب"),
    "Sheikh moderation release confirmed",
  );
  await waitFor(
    () =>
      student.evaluate(
        "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='تشغيل ميكروفوني');return !!b&&!b.disabled})()",
      ),
    "Student can explicitly opt into microphone after release",
  );
  await click(student, "تشغيل ميكروفوني");
  await waitFor(
    () => remoteAudioExists(teacher),
    "Student microphone republished after permitted opt-in",
  );
  console.log("PASS: Sheikh mute/release and voluntary learner microphone recovery");

  // CR-03: the new page is real LessonDO state, not a cosmetic local turn.
  // This test uses the same two signed actors as the WebRTC acceptance.
  const teacherPagePath = "/v1/teacher/lessons/" + encodeURIComponent(lesson) + "/quran-page";
  const learnerPagePath =
    "/v1/me/learners/" +
    encodeURIComponent(learner) +
    "/lessons/" +
    encodeURIComponent(lesson) +
    "/quran-page";
  const pageRead = (browser, url) =>
    browser.evaluate(
      "(async()=>{const r=await fetch(" +
        JSON.stringify(url) +
        ",{credentials:'same-origin',cache:'no-store'});" +
        "return {status:r.status,body:await r.json()}})()",
    );
  const pageWrite = (browser, url, payload) =>
    browser.evaluate(
      "(async()=>{const r=await fetch(" +
        JSON.stringify(url) +
        ",{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'}," +
        "body:JSON.stringify(" +
        JSON.stringify(payload) +
        ")});return {status:r.status,body:await r.json()}})()",
    );
  const first = await pageRead(teacher, teacherPagePath);
  assert.equal(first.status, 200, "Teacher shared Quran read denied");
  assert.equal(first.body.quran.edition, "hafs-kfqc-v1.1.1");
  assert.equal(first.body.quran.page, 1);
  assert.equal(first.body.quran.revision, 0);
  const initialStudent = await pageRead(student, learnerPagePath);
  assert.equal(initialStudent.body.quran.page, 1, "Learner did not see canonical shared page");
  const change = {
    action: "set",
    page: 35,
    expectedRevision: 0,
    requestId: "qa-page-change-00001",
  };
  const teacherTurn = await pageWrite(teacher, teacherPagePath, change);
  assert.equal(teacherTurn.status, 200, "Teacher page mutation was not confirmed");
  assert.equal(teacherTurn.body.quran.page, 35);
  assert.equal(teacherTurn.body.quran.revision, 1);
  const replay = await pageWrite(teacher, teacherPagePath, change);
  assert.equal(replay.body.code, "QURAN_PAGE_REPLAY", "Duplicate page event not idempotent");
  const stale = await pageWrite(teacher, teacherPagePath, {
    ...change,
    page: 36,
    requestId: "qa-page-change-00002",
  });
  assert.equal(stale.status, 409, "Stale Quran revision was not rejected");
  assert.equal(stale.body.quran.page, 35);
  const studentWrite = await pageWrite(student, learnerPagePath, change);
  assert.equal(studentWrite.status, 405, "Learner was allowed to mutate the Quran");
  const forged = await pageWrite(teacher, teacherPagePath, { ...change, role: "learner" });
  assert.equal(forged.status, 400, "Browser-forged shared Quran identity was accepted");
  const confirmedStudent = await pageRead(student, learnerPagePath);
  assert.equal(confirmedStudent.status, 200);
  assert.equal(confirmedStudent.body.quran.page, 35);
  // The approved learner phone layout deliberately hides the Quran footer;
  // assert the canonical printed page itself, not presentation-only text.
  const renderedPage35 = (browser) =>
    browser.evaluate(
      "(()=>{const art=document.querySelector('[data-rendered-quran-page=\"35\"]');" +
        'const sheet=art?.closest(\'[role="group"][aria-label^="مصحف المدينة"]\');' +
        "const r=art?.getBoundingClientRect();" +
        "return !!art && !!sheet && sheet.getAttribute('aria-label')==='مصحف المدينة، الصفحة 35' " +
        "&& !!r && r.width>100 && r.height>100 && !sheet.closest('[aria-busy=\"true\"]')})()",
    );
  await Promise.all([
    waitFor(() => renderedPage35(teacher), "Teacher rendered canonical Quran page 35"),
    waitFor(() => renderedPage35(student), "Student rendered synchronized Quran page 35"),
  ]);
  console.log(
    "PASS: CR-03 signed teacher page change synced to learner; durable revision, replay, stale CAS, role denial",
  );
  // The Sheikh's actual navigation controls must drive the same persistent DO
  // that the learner follows; a direct API-only write is not enough for UX QA.
  const clickPageArrow = async (browser, label) => {
    const expression =
      "(()=>{const buttons=[...document.querySelectorAll('button[aria-label=" +
      JSON.stringify(label) +
      "]')];const b=buttons.find(x=>!x.disabled&&x.getBoundingClientRect().width>10);" +
      "if(!b)return false;b.click();return true})()";
    await waitFor(() => browser.evaluate(expression), "visible Sheikh page control: " + label);
  };
  const rendered = (browser, pageNumber) =>
    browser.evaluate(
      "(()=>{const art=document.querySelector('[data-rendered-quran-page=" +
        JSON.stringify(String(pageNumber)) +
        "]');const r=art?.getBoundingClientRect();" +
        "return !!art && !!r && r.width>100 && r.height>100})()",
    );
  await clickPageArrow(teacher, "الصفحة التالية");
  await waitFor(
    async () => (await pageRead(student, learnerPagePath)).body?.quran?.page === 36,
    "teacher next button sends shared page 36",
  );
  await Promise.all([
    waitFor(() => rendered(teacher, 36), "teacher displays next Quran page 36"),
    waitFor(() => rendered(student, 36), "student follows next Quran page 36"),
  ]);
  await clickPageArrow(teacher, "الصفحة السابقة");
  await waitFor(
    async () => (await pageRead(student, learnerPagePath)).body?.quran?.page === 35,
    "teacher previous button restores shared page 35",
  );
  await Promise.all([
    waitFor(() => rendered(teacher, 35), "teacher restores Quran page 35"),
    waitFor(() => rendered(student, 35), "student follows restored Quran page 35"),
  ]);
  console.log(
    "PASS: Sheikh's actual side-rail page buttons synchronize both printed Quran readers",
  );

  // CR-04: teacher-only persistent ink, visible to student; forbidden learner
  // writes and stale/fake ink operations remain rejected on the real Worker.
  const teacherInkPath = "/v1/teacher/lessons/" + encodeURIComponent(lesson) + "/quran-ink";
  const learnerInkPath =
    "/v1/me/learners/" +
    encodeURIComponent(learner) +
    "/lessons/" +
    encodeURIComponent(lesson) +
    "/quran-ink";
  const inkMark = {
    id: "ink-qa-verified-0001",
    page: 35,
    color: "#388e68",
    width: 3,
    kind: "pen",
    points: [
      { x: 120, y: 220 },
      { x: 240, y: 300 },
    ],
  };
  const inkAction = {
    action: "add",
    page: 35,
    expectedRevision: 0,
    requestId: "qa-ink-add-0001",
    stroke: inkMark,
  };
  const initialInk = await pageRead(teacher, teacherInkPath + "?page=35");
  assert.equal(initialInk.status, 200);
  assert.equal(initialInk.body.ink.revision, 0);
  const addedInk = await pageWrite(teacher, teacherInkPath, inkAction);
  assert.equal(addedInk.status, 200);
  assert.equal(addedInk.body.ink.revision, 1);
  assert.deepEqual(addedInk.body.ink.strokes, [inkMark]);
  assert.equal((await pageWrite(teacher, teacherInkPath, inkAction)).body.code, "INK_REPLAY");
  assert.equal(
    (await pageWrite(teacher, teacherInkPath, { ...inkAction, requestId: "qa-ink-add-0002" }))
      .status,
    409,
  );
  assert.equal((await pageWrite(student, learnerInkPath, inkAction)).status, 405);
  assert.equal(
    (await pageWrite(teacher, teacherInkPath, { ...inkAction, role: "learner" })).status,
    400,
  );
  const studentInk = await pageRead(student, learnerInkPath + "?page=35");
  assert.equal(studentInk.status, 200);
  assert.deepEqual(studentInk.body.ink.strokes, [inkMark]);
  const markVisible = (browser) =>
    browser.evaluate(
      '!!document.querySelector(\'svg[aria-label="طبقة الرسم على المصحف"] path[stroke="#388e68"]\')',
    );
  await Promise.all([
    waitFor(() => markVisible(teacher), "teacher canonical green ink visible"),
    waitFor(() => markVisible(student), "learner receives signed teacher ink"),
  ]);
  const teacherPenReady = await teacher.evaluate(
    "(()=>{const b=document.querySelector('button[aria-label=\"قلم\"]');return !!b&&!b.disabled})()",
  );
  const learnerPenDenied = await student.evaluate(
    "(()=>{const b=document.querySelector('button[aria-label=\"قلم\"]');return !!b&&b.disabled})()",
  );
  assert.equal(teacherPenReady, true, "Teacher ink tool never became available");
  assert.equal(learnerPenDenied, true, "Learner drew without a teacher-controlled grant");
  console.log("PASS: signed teacher pen persisted and visible in both browser ink overlays");

  await snapshot(teacher, 1280, 900, "teacher-desktop-1280");
  await snapshot(student, 390, 844, "student-mobile-390");
  await snapshot(student, 360, 667, "student-mobile-360");
  console.log(
    "PASS: bidirectional real WebRTC with synthetic A/V tracks and responsive screenshots",
  );

  const hiddenInk = await pageWrite(teacher, teacherInkPath, {
    action: "hide",
    page: 35,
    expectedRevision: 1,
    requestId: "qa-ink-hide-0001",
    strokeId: inkMark.id,
  });
  assert.equal(hiddenInk.status, 200);
  assert.equal(hiddenInk.body.ink.revision, 2);
  assert.deepEqual(hiddenInk.body.ink.strokes, []);
  await Promise.all([
    waitFor(async () => !(await markVisible(teacher)), "teacher eraser hides stroke"),
    waitFor(async () => !(await markVisible(student)), "learner sees erased stroke"),
  ]);
  console.log("PASS: eraser tombstone visible to both; underlying Quran unchanged");

  await click(student, "إنهاء اتصال الصوت والفيديو");
  await waitFor(() => has(student, "دخول الصوت والفيديو"), "student media disconnect");
  await click(student, "دخول الصوت والفيديو");
  await waitFor(() => mediaReady(student), "student fresh signed WebRTC reconnect");
  console.log("PASS: student LiveKit media disconnect and reconnect");
  await click(student, "مغادرة الحصة");
  await waitFor(() => has(student, "الانضمام لغرفة الانتظار"), "signed student DO leave");
  await click(teacher, "مغادرة الحصة");
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
