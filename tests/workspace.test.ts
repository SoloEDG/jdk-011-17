import assert from "node:assert";
import { test } from "node:test";
import { reactive } from "vue";
import {
  save,
  load,
  switchWorld,
  createNewWorld,
  restoreVersion,
  cancelLoad,
  importWorld,
  store,
  isDirty,
} from "../src/features/archive/model/archive";
import type { KVStorage } from "../src/features/archive/lib/vault-types";
import { createWorld } from "../src/features/world/lib/terrain";
import { key, type Workspace } from "../src/shared/document";

function memKV(): KVStorage {
  const map: Record<string, string> = {};
  return {
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => (map[k] = v),
    removeItem: (k) => delete map[k],
  } as KVStorage;
}

function setupStore() {
  store.attach({ kv: memKV(), flush: (t) => t() });
}

function workspace(): Workspace {
  return reactive<Workspace>({
    doc: createWorld(),
    material: "brick",
    tool: "select",
    region: null,
    anchor: null,
    message: "",
    dirty: false,
    mode: "build",
    savedAt: null,
    slotId: "",
    savedRevision: 0,
    loadEpoch: 0,
    pendingLoad: null,
  });
}

function placeOne(s: Workspace, x: number) {
  const p = { x, y: 8, z: 8 };
  s.doc.blocks[key(p)] = { ...p, material: "brick" };
  s.doc.inventory.brick--;
  s.doc.revision++;
  s.dirty = true;
}

test("模型：保存后新增建造仍标记为未保存，提示对应实际写入版本", async () => {
  setupStore();
  const s = workspace();
  createNewWorld(s);
  placeOne(s, 10);
  await save(s);
  assert.equal(isDirty(s), false);
  // 保存完成后再建造
  placeOne(s, 11);
  assert.equal(isDirty(s), true);
  assert.match(s.message, /历史版本/);
  // 再存一次，点击后立刻继续建造
  placeOne(s, 12);
  const savePromise = save(s);
  const clickRev = s.doc.revision;
  placeOne(s, 13);
  await savePromise;
  assert.equal(s.savedRevision, clickRev);
  assert.equal(isDirty(s), true, "保存过程中新增的建造不能被标记为已保存");
  assert.match(s.message, /新建造尚未保存/);
});

test("模型：撤回载入恢复原世界、选区与库存", async () => {
  setupStore();
  const s = workspace();
  createNewWorld(s);
  placeOne(s, 10);
  s.region = { a: { x: 1, y: 2, z: 3 }, b: { x: 4, y: 5, z: 6 } };
  s.material = "glass";
  s.tool = "select";
  await save(s);
  const before = {
    blocks: Object.keys(s.doc.blocks).length,
    brick: s.doc.inventory.brick,
    region: s.region && { ...s.region },
    material: s.material,
  };
  // 再做一些未保存改动，然后重载
  placeOne(s, 11);
  load(s);
  assert.ok(s.pendingLoad);
  assert.equal(Object.keys(s.doc.blocks).length, before.blocks);
  assert.equal(s.region, null, "载入会清空当前选区");
  // 撤回：原世界、选区、库存都回来
  cancelLoad(s);
  assert.equal(s.pendingLoad, null);
  assert.equal(Object.keys(s.doc.blocks).length, before.blocks + 1);
  assert.equal(s.doc.inventory.brick, before.brick - 1);
  assert.deepEqual(s.region, before.region);
  assert.equal(s.material, "glass");
});

test("模型：切换世界可撤回，撤回后回到原槽位与现场", async () => {
  setupStore();
  const s = workspace();
  createNewWorld(s);
  placeOne(s, 10);
  await save(s);
  const firstId = s.slotId;
  // 第二个世界
  createNewWorld(s);
  const secondId = s.slotId;
  placeOne(s, 12);
  await save(s);
  // 未保存的新改动：切换世界时需要可撤回
  placeOne(s, 20);
  const blocksBeforeSwitch = Object.keys(s.doc.blocks).length;
  switchWorld(s, firstId);
  assert.equal(s.slotId, firstId);
  assert.ok(s.pendingLoad);
  cancelLoad(s);
  assert.equal(s.slotId, secondId);
  assert.equal(Object.keys(s.doc.blocks).length, blocksBeforeSwitch);
});

test("模型：恢复历史版本可撤回，撤回后回到恢复前现场", async () => {
  setupStore();
  const s = workspace();
  createNewWorld(s);
  placeOne(s, 10);
  await save(s);
  const slotId = s.slotId;
  const firstName = s.doc.name;
  // 存第二个历史版本
  placeOne(s, 13);
  await save(s);
  // 恢复前再做一处未保存改动
  placeOne(s, 14);
  assert.equal(isDirty(s), true);
  const blocksBeforeRestore = Object.keys(s.doc.blocks).length;
  const oldest = store.getSlot(slotId)!.chain[0].seq;
  restoreVersion(s, oldest);
  assert.ok(s.pendingLoad);
  assert.notEqual(Object.keys(s.doc.blocks).length, blocksBeforeRestore);
  cancelLoad(s);
  assert.equal(s.slotId, slotId);
  assert.equal(s.doc.name, firstName);
  assert.equal(Object.keys(s.doc.blocks).length, blocksBeforeRestore);
});

test("模型：导入文件成为独立新槽位，不覆盖当前世界", async () => {
  setupStore();
  const s = workspace();
  createNewWorld(s);
  placeOne(s, 10);
  await save(s);
  const currentId = s.slotId;
  const incoming = createWorld();
  incoming.name = "导入的地图";
  incoming.revision = 0;
  const file = new File([JSON.stringify(incoming)], "in.json", {
    type: "application/json",
  });
  await importWorld(s, file);
  assert.notEqual(s.slotId, currentId);
  assert.equal(store.getSlot(currentId)!.chain.length, 1);
  assert.equal(s.doc.name, "导入的地图");
});
