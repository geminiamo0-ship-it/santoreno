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
  await browser.go("/student/account/");
  await present("#create-learner-form");
  await fill({ name: "Synthetic Dev Learner B", learnerType: "child" }, "#create-learner-form");
  await waitFor(async () => (await names()).length === 2, "second synthetic learner");
  const id = await browser.evaluate(
    "fetch('/v1/me/learners',{cache:'no-store'}).then(r=>r.json()).then(d=>d.learners.find(l=>l.name==='Synthetic Dev Learner B')?.id)",
  );
  assert.match(id, /^[0-9a-f-]{36}$/i);
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
    const header = await browser.evaluate(`(()=>{
      const learner = ${JSON.stringify(longLearner)};
      const select=document.querySelector('#learner-switch');
      const label=document.querySelector('[class*="selectedLearnerName"]');
      const logout=document.querySelector('#account-logout');
      const bar=document.querySelector('header');
      return {
        width:Math.round(select?.getBoundingClientRect().width??0),
        selectTitle:select?.getAttribute('title'),
        longNameVisible:label?.textContent===learner &&
          getComputedStyle(label).display!=='none' &&
          label.getBoundingClientRect().width>0,
        logoutAccessible:Boolean(logout&&logout.getBoundingClientRect().width>0),
        headerBottom:Math.round(bar?.getBoundingClientRect().bottom??0),
      };
    })()`);
    assert.equal(header.selectTitle,longLearner,'Header must expose complete selected learner title');
    assert(header.logoutAccessible,'Logout control inaccessible at '+width);
    if(width<=390){
      assert(header.width>=200,'Clipped narrow learner selector '+width+' '+header.width);
      assert(header.longNameVisible,'Long Arabic name not visible at '+width);
      await browser.evaluate("document.querySelector('[aria-controls=student-navigation-mobile]').click()");
      await present('#student-navigation-mobile');
      const menu=await browser.evaluate(`(()=>{
        const bar=document.querySelector('header').getBoundingClientRect();
        const nav=document.querySelector('#student-navigation-mobile').getBoundingClientRect();
        return {top:nav.top,headerBottom:bar.bottom,left:nav.left,right:nav.right,width:innerWidth};
      })()`);
      assert(menu.top>=menu.headerBottom-2,'Mobile menu covers header at '+width);
      assert(menu.left>=-1&&menu.right<=menu.width+1,'Mobile menu horizontal overflow '+width);
      await browser.evaluate("document.querySelector('[aria-controls=student-navigation-mobile]').click()");
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
    "PASS: Remote Noor Chrome connected account 5 viewports, RTL, rename, D1 refresh, archive and foreign-owner 404",
  );
} catch (error) {
  await browser.screenshot("artifacts/noor-staging-profile/failure.png").catch(() => {});
  throw error;
} finally {
  await browser.close();
}
