import assert from "node:assert";
import { test } from "node:test";
import {
  clone,
  diffDocs,
  applyDelta,
  materialize,
  compactChain,
} from "../src/features/archive/lib/chain";
import { VaultStore, sameDoc } from "../src/features/archive/lib/vault";
import {
  VAULT_KEY,
  LEGACY_KEY,
  type KVStorage,
} from "../src/features/archive/lib/vault-types";
import { createWorld } from "../src/features/world/lib/terrain";
import { key } from "../src/shared/document";
import type { WorldDocument } from "../src/shared/document";
import { encode, decode } from "../src/features/archive/lib/codec";

function memKV(initial: Record<string, string> = {}): KVStorage & {
  map: Record<string, string>;
} {
  return {
    map: initial,
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(this.map, k)
        ? this.map[k]
        : null;
    },
    setItem(k, v) {
      this.map[k] = v;
    },
    removeItem(k) {
      delete this.map[k];
    },
  };
}

function quotaKV(cap: number) {
  const map: Record<string, string> = {};
  return {
    map,
    getItem(k: string) {
      return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
    },
    setItem(k: string, v: string) {
      if (v.length > cap)
        throw new DOMException("quota", "QuotaExceededError");
      map[k] = v;
    },
    removeItem(k: string) {
      delete map[k];
    },
  };
}

function doc() {
  return createWorld();
}

function place(d: WorldDocument, n: number, material: WorldDocument["blocks"][string]["material"] = "stone") {
  for (let i = 0; i < n; i++) {
    const p = { x: 10 + i, y: 5, z: 10 };
    d.blocks[key(p)] = { ...p, material };
    d.inventory[material]--;
  }
  d.revision += n;
  return d;
}

test("增量链：diff/apply 往返与基线一致", () => {
  const base = doc();
  const next = place(doc(), 3, "brick");
  next.player.x += 2;
  const delta = diffDocs(base, next);
  assert.equal(Object.keys(delta.put).length, 3);
  const rebuilt = applyDelta(base, delta);
  assert.ok(sameDoc(rebuilt, next));
});

test("压缩：删除中间版本后保留版本仍可独立物化", async () => {
  let clock = 1000;
  const store = new VaultStore({
    kv: memKV(),
    flush: (t) => t(),
    now: () => (clock += 1000),
  });
  store.init();
  const id = store.createSlot("w");
  let d = doc();
  for (let i = 0; i < 6; i++) {
    d = place(d, 1, "stone");
    const out = await store.saveSlot(id, d);
    assert.equal(out.status, "saved");
  }
  const slot = store.getSlot(id)!;
  const target = slot.chain[2].seq;
  const before = materialize(slot.chain, target);
  assert.ok(store.purgeVersion(id, target));
  const after = store.getSlot(id)!;
  // 被删版本物化不到
  assert.throws(() => materialize(after.chain, target));
  // 其余每个保留版本都能读取，且内容与删除前一致
  for (const e of after.chain) {
    const expect = materialize(slot.chain, e.seq);
    assert.ok(sameDoc(materialize(after.chain, e.seq), expect));
  }
  assert.ok(sameDoc(materialize(after.chain), before) === false);
});

test("保存期间继续建造：写入的是点击时刻版本，新建造不被标记已保存", async () => {
  const kv = memKV();
  const store = new VaultStore({ kv, flush: (t) => t() });
  store.init();
  const id = store.createSlot("w");
  const clicked = place(doc(), 2, "wood");
  const clickRevision = clicked.revision;
  const out = await store.saveSlot(id, clicked);
  assert.equal(out.status, "saved");
  assert.equal(out.revision, clickRevision);
  // 点击之后又加了方块（模拟保存过程中继续建造），存储内容不含这些新方块
  place(clicked, 5, "glass");
  const stored = materialize(store.getSlot(id)!.chain);
  assert.equal(stored.revision, clickRevision);
  const raw = JSON.parse(kv.map[VAULT_KEY]);
  const last = raw.slots[id].chain.at(-1);
  assert.equal(last.kind === "snapshot" ? last.doc.revision : last.revision, clickRevision);
});

test("切换世界后迟到写入不能覆盖新槽位", async () => {
  const queue: (() => void)[] = [];
  const kv = memKV();
  const store = new VaultStore({ kv, flush: (t) => queue.push(t) });
  store.init();
  const a = store.createSlot("A");
  const b = store.createSlot("B");
  void store.saveSlot(a, place(doc(), 1, "wood"));
  queue.shift()!();
  const docA = store.exportVersion(a);
  // 在 B 上先存一版
  void store.saveSlot(b, place(doc(), 4, "sand"));
  queue.shift()!();
  // A 再发起保存（内容不同于已存版本），但刷新前切换到 B
  const pending = place(clone(docA), 2, "brick");
  const promise = store.saveSlot(a, pending);
  store.switchSlot(b);
  queue.shift()!();
  const out = await promise;
  assert.equal(out.status, "stale");
  // B 槽位内容不变，A 也没有被迟到写入污染
  assert.equal(store.vault.activeSlotId, b);
  assert.equal(store.getSlot(a)!.chain.length, 1);
  assert.ok(sameDoc(store.exportVersion(b), materialize(store.getSlot(b)!.chain)));
});

test("快照节奏：每 3 个增量后落一次快照，链始终可物化", async () => {
  const kv = memKV();
  const store = new VaultStore({ kv, flush: (t) => t() });
  store.init();
  const id = store.createSlot("w");
  let d = doc();
  for (let i = 0; i < 9; i++) {
    d = place(d, 1, "stone");
    const out = await store.saveSlot(id, d);
    assert.equal(out.status, "saved");
  }
  const chain = store.getSlot(id)!.chain;
  const snapshots = chain.filter((e) => e.kind === "snapshot");
  const deltas = chain.filter((e) => e.kind === "delta");
  assert.equal(chain.length, 9);
  assert.equal(snapshots.length, 3);
  assert.equal(deltas.length, 6);
  // 任意连续增量不超过 3 个
  let run = 0;
  for (const e of chain) {
    run = e.kind === "delta" ? run + 1 : 0;
    assert.ok(run <= 3);
  }
  // 每个版本都能独立物化且内容正确
  assert.ok(sameDoc(materialize(chain), d));
});

test("版本上限与空间配额：自动剪旧版本且保住最新版本", async () => {
  const kv = memKV();
  const store = new VaultStore({ kv, flush: (t) => t() });
  store.init();
  const id = store.createSlot("w");
  let d = doc();
  for (let i = 0; i < 14; i++) {
    d = place(d, 1, "stone");
    const out = await store.saveSlot(id, d);
    assert.equal(out.status, "saved");
  }
  const slot = store.getSlot(id)!;
  assert.ok(slot.chain.length <= 10);
  assert.ok(sameDoc(materialize(slot.chain), d));
});

test("配额耗尽：淘汰旧版本后仍失败则拒绝写入且旧库完好", async () => {
  const kv = quotaKV(2048); // 容得下空 vault，容不下世界文档
  const store = new VaultStore({ kv, flush: (t) => t() });
  store.init();
  const id = store.createSlot("w");
  const before = kv.map[VAULT_KEY];
  const out = await store.saveSlot(id, place(doc(), 1, "wood"));
  assert.equal(out.status, "failed");
  // 失败后旧 vault 保持原样，没有半截数据
  assert.equal(kv.map[VAULT_KEY], before);
});

test("配额逐步收紧：空间不足时先清理较早版本，最新状态可恢复", async () => {
  // 约可容纳两个版本：第三次保存触发配额，清理掉较早版本后最新状态仍保住
  const kv = quotaKV(110 * 1024);
  const store = new VaultStore({ kv, flush: (t) => t() });
  store.init();
  const id = store.createSlot("w");
  let d = doc();
  let lastSaved: WorldDocument | null = null;
  let prunedTotal = 0;
  for (let i = 0; i < 8; i++) {
    d = place(d, 2, "stone");
    const out = await store.saveSlot(id, d);
    assert.notEqual(out.status, "failed", "自动清理后应仍能保住最新版本");
    if (out.status === "saved") {
      lastSaved = clone(d);
      prunedTotal += out.pruned;
    }
  }
  assert.ok(prunedTotal > 0, "应当发生过旧版本自动清理");
  const slot = store.getSlot(id)!;
  assert.ok(slot.chain.length >= 1, "至少保住一个可恢复版本");
  assert.ok(sameDoc(materialize(slot.chain), lastSaved!));
});

test("旧单槽数据升级为可辨认的首个世界", () => {
  const d = doc();
  const kv = memKV({ [LEGACY_KEY]: encode(d) });
  const store = new VaultStore({ kv, flush: (t) => t() });
  const { migrated } = store.init();
  assert.equal(migrated, true);
  const slots = store.listSlots();
  assert.equal(slots.length, 1);
  assert.equal(slots[0].legacy, true);
  assert.equal(slots[0].name, d.name);
  assert.equal(kv.getItem(LEGACY_KEY), null);
  assert.ok(sameDoc(materialize(store.getSlot(slots[0].id)!.chain), d));
  // 再次初始化不会重复迁移
  assert.equal(new VaultStore({ kv, flush: (t) => t() }).init().migrated, false);
});

test("迁移失败时旧键保留", () => {
  const d = doc();
  const kv = quotaKV(0);
  kv.map[LEGACY_KEY] = encode(d);
  const store = new VaultStore({ kv, flush: (t) => t() });
  assert.throws(() => store.init());
  assert.equal(kv.getItem(LEGACY_KEY), encode(d));
});
test("导入成为新槽位且不覆盖现有世界，导出文件可独立解码", async () => {
  const kv = memKV();
  const store = new VaultStore({ kv, flush: (t) => t() });
  store.init();
  const first = store.importSlot(place(doc(), 1, "wood"));
  const again = store.importSlot(place(doc(), 2, "wood"));
  assert.notEqual(first, again);
  assert.equal(store.getSlot(first)!.chain.length, 1);
  const exported = store.exportVersion(again);
  assert.ok(sameDoc(decode(encode(exported)), exported));
});

test("手动清理一个版本不会让后续版本无法读取", async () => {
  const kv = memKV();
  const store = new VaultStore({ kv, flush: (t) => t() });
  store.init();
  const id = store.createSlot("w");
  let d = doc();
  for (let i = 0; i < 5; i++) d = place(d, 1, "brick");
  const saved = await store.saveSlot(id, d);
  assert.equal(saved.status, "saved");
  const slot = store.getSlot(id)!;
  assert.ok(slot.chain.length >= 1);
  // 单版本时最新版本受保护
  const head = slot.chain.at(-1)!.seq;
  assert.equal(store.purgeVersion(id, head), false);
});
