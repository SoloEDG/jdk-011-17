import { chromium } from "playwright";
import assert from "node:assert";

const BASE = "http://127.0.0.1:5199";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot(seed?: Record<string, string>) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.addInitScript((data) => {
    for (const [k, v] of Object.entries(data ?? {}))
      localStorage.setItem(k, v);
  }, seed ?? {});
  await page.goto(BASE);
  await page.waitForSelector("canvas");
  return { browser, page, errors };
}

async function statusText(page: import("playwright").Page) {
  return page.locator(".statusbar span").first().innerText();
}

async function run() {
  // 1. 空库启动不报错，能新建世界并保存出历史版本
  let ctx = await boot();
  let page = ctx.page;
  await page.getByRole("button", { name: /新建世界/ }).click();
  await page.getByRole("button", { name: "保存世界" }).first().click();
  await sleep(250);
  let msg = await statusText(page);
  assert.match(msg, /历史版本/, `首次保存提示异常: ${msg}`);
  const vault1 = await page.evaluate(() => localStorage.getItem("blockhaven-vault-v2"));
  assert.ok(vault1 && JSON.parse(vault1).format === 2);
  // 版本列表出现且包含快照
  const versionCount = await page.locator(".version-item").count();
  assert.ok(versionCount >= 1);
  await ctx.browser.close();

  // 2. 旧单槽数据迁移
  const legacyDoc = {
    version: 1,
    name: "老存档世界",
    blocks: { "1,2,3": { x: 1, y: 2, z: 3, material: "stone" } },
    inventory: Object.fromEntries(
      ["grass","soil","stone","wood","sand","brick","glass","leaf"].map((m) => [m, 10]),
    ),
    player: { x: 0, y: 3, z: 9 },
    revision: 7,
  };
  ctx = await boot({ "blockhaven-world-v1": JSON.stringify(legacyDoc) });
  page = ctx.page;
  msg = await statusText(page);
  assert.match(msg, /旧版单槽存档已升级/, `迁移提示异常: ${msg}`);
  const migrated = await page.evaluate(() => {
    const v = JSON.parse(localStorage.getItem("blockhaven-vault-v2")!);
    return {
      slots: Object.keys(v.slots).length,
      legacy: Object.values(v.slots)[0].legacy,
      name: Object.values(v.slots)[0].name,
      legacyKey: localStorage.getItem("blockhaven-world-v1"),
    };
  });
  assert.equal(migrated.slots, 1);
  assert.equal(migrated.legacy, true);
  assert.equal(migrated.name, "老存档世界");
  assert.equal(migrated.legacyKey, null);
  assert.ok((await page.locator(".legacy-tag").count()) >= 1);

  // 3. 两个槽位：保存隔离与切换
  await page.getByRole("button", { name: /新建世界/ }).click();
  await page.getByRole("button", { name: "保存世界" }).first().click();
  await sleep(250);
  const slotItems = page.locator(".slot-item");
  assert.equal(await slotItems.count(), 2);
  // 切回第一个（旧版迁入）世界
  await slotItems.nth(1).click();
  await sleep(100);
  msg = await statusText(page);
  assert.match(msg, /已切换到世界/);
  assert.ok((await page.locator(".pending-banner").count()) >= 1, "切换后出现撤回横幅");
  // 撤回
  await page.getByRole("button", { name: /撤回载入/ }).click();
  msg = await statusText(page);
  assert.match(msg, /原世界、选区和库存都回来了/);
  await ctx.browser.close();

  // 4. 刷新页面后槽位仍在（持久化）
  ctx = await boot();
  page = ctx.page;
  await page.waitForSelector(".slot-item");
  assert.equal(await page.locator(".slot-item").count(), 2);
  assert.deepEqual(ctx.errors, [], `控制台错误: ${ctx.errors.join(" | ")}`);
  await ctx.browser.close();

  console.log("E2E_OK");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
