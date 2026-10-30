// #242: Real Chrome against the existing Noor development staging only.
// No production endpoints, secrets in screenshots, or real children/phone numbers.
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { openNoorStagingChrome, waitFor } from "../noor/scripts/chrome-local.mjs";

const base = process.env.NOOR_STAGING_ORIGIN;
const browser = await openNoorStagingChrome(base);
const password = "Synthetic-Noor-2026-" + randomInt(100000000, 999999999) + "!Aa";
const phoneSeed = randomInt(1000000, 8999998);
const phone = (offset) => "+1202" + String(phoneSeed + offset).padStart(7, "0");
const ownerA = phone(0),
  ownerB = phone(1);
const longLearner = "طالب تجريبي ذو اسم عربي طويل لقياس العرض";
async function present(selector) {
  return waitFor(
    () => browser.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),
    selector,
  );
}
async function hydrated() {
  await waitFor(
    () =>
      browser.evaluate(
        "Object.keys(document.querySelector('#account-form')||{}).some(k=>k.includes('reactProps'))",
      ),
    "auth form",
  );
}
async function fill(values, selector = "#account-form") {
  await browser.evaluate(`(()=>{
    const form=document.querySelector(${JSON.stringify(selector)});
    if(!form)throw Error('Expected hydrated form');
    for(const [name,value] of Object.entries(${JSON.stringify(values)})){
      const field=form.elements.namedItem(name);
      if(!field)throw Error('Missing form field');
      field.value=value;
    }
    form.requestSubmit();
  })()`);
}
async function names() {
  return browser.evaluate(
    "[...document.querySelectorAll('#learner-switch option')].map(o=>o.textContent)",
  );
}
async function clickProfile(name, label) {
  await browser.evaluate(`(()=>{
    const name=${JSON.stringify(name)},label=${JSON.stringify(label)};
    const li=[...document.querySelectorAll('li')].find(x=>x.querySelector('strong')?.textContent===name &&
      [...x.querySelectorAll('button')].some(b=>b.textContent.trim()===label));
    if(!li)throw Error('Profile action button missing');
    [...li.querySelectorAll('button')].find(b=>b.textContent.trim()===label).click();
  })()`);
}
try {
  await browser.go("/student/");
  await hydrated();
  await browser.evaluate("document.querySelector('#account-mode-switch').click()");
  await present("#auth-name");
  await fill({
    name: "Synthetic Owner A",
    phoneNumber: ownerA,
    password,
    learnerName: longLearner,
    learnerType: "child",
  });
  await present("#learner-switch");
  assert.deepEqual(await names(), [longLearner]);
  // No local mock snapshot is permitted in authenticated student home.
  await waitFor(
    () => browser.evaluate(
      "document.querySelector('#student-main')?.textContent.includes('لا توجد حصة مجدولة حاليًا')",
    ),
    "owner-backed student home after real API reads",
  );
  const authenticatedHome = await browser.evaluate(
    "({preview:document.querySelector('#student-main')?.textContent.includes('بيانات تقييم توضيحية'),"+
    "mock:document.querySelector('#student-main')?.textContent.includes('شيخ تجريبي'),"+
    "tasks:document.querySelector('#student-main')?.textContent.includes('الواجبات المنشورة'),"+
    "error:document.querySelector('#student-main')?.textContent.includes('تعذّر التحقق من بيانات الطالب')})",
  );
  assert.equal(authenticatedHome.preview, false, "Signed student dashboard contains example grades");
  assert.equal(authenticatedHome.mock, false, "Signed student dashboard contains mock teacher");
  assert.equal(authenticatedHome.tasks, true, "Signed student dashboard lacks real task summary");
  assert.equal(authenticatedHome.error, false, "Signed student owner APIs failed");
  await browser.screenshot("artifacts/noor-staging-profile/student-home-real.png");

  await browser.go("/student/subscription/");
  await waitFor(
    () => browser.evaluate(
      "document.querySelector('#student-main')?.textContent.includes('الحالة المالية غير متاحة للتحقق')",
    ),
    "unverified financial ledger must be explicitly unknown",
  );
  assert.equal(
    await browser.evaluate(
      "document.querySelector('#student-main')?.textContent.includes('نشط في بيانات التجربة')",
    ),
    false,
    "Live subscription status must not be inherited from fixtures",
  );
  await browser.go("/student/lessons/");
  await waitFor(
    () => browser.evaluate(
      "document.querySelector('#student-main')?.textContent.includes('مواعيد حساب الطالب الحقيقي')",
    ),
    "signed lesson schedule, not booking mock",
  );
  await browser.go("/student/account/");
  await present("#create-learner-form");
  await fill({ name: "Synthetic Dev Learner B", learnerType: "child" }, "#create-learner-form");
  await waitFor(async () => (await names()).length === 2, "second synthetic learner");
  const id = await browser.evaluate(
    "fetch('/v1/me/learners',{cache:'no-store'}).then(r=>r.json()).then(d=>d.learners.find(l=>l.name==='Synthetic Dev Learner B')?.id)",
  );
  assert.match(id, /^[0-9a-f-]{36}$/i);
  await browser.evaluate(`(()=>{
    const select=document.querySelector('#learner-switch');
    const option=[...select.options].find(o=>o.textContent===${JSON.stringify(longLearner)});
    if(!option)throw Error('Missing synthetic learner');
    select.value=option.value;
    select.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitFor(
    () =>
      browser.evaluate(
        `document.querySelector('#learner-switch')?.title===${JSON.stringify(longLearner)}`,
      ),
    "Long Arabic learner selected",
  );
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
    const result = await browser.evaluate(
      "({dir:document.documentElement.dir,scroll:document.documentElement.scrollWidth,width:innerWidth})",
    );
    assert.equal(result.dir, "rtl");
    assert(result.scroll <= result.width, "Account horizontal overflow at " + width);
    const selected = await browser.evaluate(`(()=>{
      const select=document.querySelector('#learner-switch');
      const label=document.querySelector('[class*="selectedLearnerName"]');
      return {width:select.getBoundingClientRect().width,
        visible:label?.textContent===${JSON.stringify(longLearner)} &&
          getComputedStyle(label).display!=='none'};
    })()`);
    if (width <= 390) {
      assert(selected.width >= 200, "Mobile learner selector clipped at " + width);
      assert(selected.visible, "Arabic learner name not visible at " + width);
      await browser.evaluate(
        "document.querySelector('[aria-controls=student-navigation-mobile]').click()",
      );
      await present("#student-navigation-mobile");
      const menuClear = await browser.evaluate(
        "document.querySelector('#student-navigation-mobile').getBoundingClientRect().top >= document.querySelector('header').getBoundingClientRect().bottom - 2",
      );
      assert(menuClear, "Mobile navigation overlaps header at " + width);
      await browser.evaluate(
        "document.querySelector('[aria-controls=student-navigation-mobile]').click()",
      );
    }
    await browser.screenshot("artifacts/noor-staging-profile/account-" + width + ".png");
  }
  await clickProfile("Synthetic Dev Learner B", "تعديل الاسم");
  await present('form[id^="rename-profile-"]');
  await browser.evaluate(`(()=>{
    const form=document.querySelector('form[id^="rename-profile-"]');
    form.querySelector('input[name="profileName"]').value='Synthetic Dev Learner B Updated';
    form.requestSubmit();
  })()`);
  await waitFor(
    async () => (await names()).includes("Synthetic Dev Learner B Updated"),
    "confirmed remote name update",
  );
  const revised = await browser.evaluate(`fetch('/v1/me/learners',{cache:'no-store'})
    .then(r=>r.json()).then(d=>d.learners.find(l=>l.id===${JSON.stringify(id)}))`);
  assert.equal(revised.name, "Synthetic Dev Learner B Updated");
  assert.equal(revised.revision, 2);
  await browser.go("/student/");
  await present("#learner-switch");
  assert.deepEqual(await names(), [longLearner, "Synthetic Dev Learner B Updated"]);
  await browser.go("/student/account/");
  await present("#create-learner-form");
  await clickProfile("Synthetic Dev Learner B Updated", "أرشفة الملف");
  await present('[id^="archive-profile-"]');
  await browser.evaluate(`(()=>{
    const panel=document.querySelector('[id^="archive-profile-"]');
    [...panel.querySelectorAll('button')].find(x=>x.textContent.trim()==='تأكيد الأرشفة').click();
  })()`);
  await waitFor(async () => (await names()).length === 1, "remote archive server ACK");
  await browser.go("/student/");
  await present("#learner-switch");
  assert.deepEqual(await names(), [longLearner]);
  const closed = await browser.evaluate(
    `fetch('/v1/learners/${id}',{cache:'no-store'}).then(r=>r.status)`,
  );
  assert.equal(closed, 404);
  await browser.evaluate("document.querySelector('#account-logout').click()");
  await hydrated();
  await browser.evaluate("document.querySelector('#account-mode-switch').click()");
  await present("#auth-name");
  await fill({
    name: "Synthetic Owner B",
    phoneNumber: ownerB,
    password,
    learnerName: "Synthetic Other Owner",
    learnerType: "adult",
  });
  await present("#learner-switch");
  assert.deepEqual(await names(), ["Synthetic Other Owner"]);
  const foreign = await browser.evaluate(
    `fetch('/v1/learners/${id}',{cache:'no-store'}).then(r=>r.status)`,
  );
  assert.equal(foreign, 404);
  console.log(
    "PASS: Student owner-scoped real home/subscription/lessons, five RTL viewports, sibling rename/archive and foreign-owner 404; zero demo dashboard",
  );
} catch (error) {
  await browser.screenshot("artifacts/noor-staging-profile/failure.png").catch(() => {});
  throw error;
} finally {
  await browser.close();
}
