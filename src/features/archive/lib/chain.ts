import type { Block, MaterialId, Vec3, WorldDocument } from "../../../shared/document";
import { key } from "../../../shared/document";

/** 存档数据全是 JSON 可序列化类型；JSON 克隆同时能剥离 Vue reactive 代理。 */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export interface EntryMeta {
  seq: number;
  at: number;
  label: string;
}
export interface SnapshotEntry extends EntryMeta {
  kind: "snapshot";
  doc: WorldDocument;
}
export interface DeltaEntry extends EntryMeta {
  kind: "delta";
  base: number;
  put: Record<string, Block>;
  removed: string[];
  inventory: Partial<Record<MaterialId, number>>;
  player: Vec3;
  revision: number;
  name: string;
}
export type ChainEntry = SnapshotEntry | DeltaEntry;

export function isEmptyDelta(e: DeltaEntry) {
  return (
    Object.keys(e.put).length === 0 &&
    e.removed.length === 0 &&
    Object.keys(e.inventory).length === 0
  );
}

/** 以 base 文档为基准，计算到达 doc 的增量。 */
export function diffDocs(base: WorldDocument, doc: WorldDocument): DeltaEntry {
  const put: Record<string, Block> = {};
  const removed: string[] = [];
  for (const [k, b] of Object.entries(doc.blocks)) {
    const old = base.blocks[k];
    if (!old || old.material !== b.material) put[k] = { ...b };
  }
  for (const k of Object.keys(base.blocks)) if (!doc.blocks[k]) removed.push(k);
  const inventory: Partial<Record<MaterialId, number>> = {};
  for (const id of Object.keys(doc.inventory) as MaterialId[])
    if (base.inventory[id] !== doc.inventory[id])
      inventory[id] = doc.inventory[id];
  return {
    kind: "delta",
    base: base.revision,
    seq: 0,
    at: 0,
    label: "",
    put,
    removed,
    inventory,
    player: { ...doc.player },
    revision: doc.revision,
    name: doc.name,
  };
}

export function applyDelta(base: WorldDocument, e: DeltaEntry): WorldDocument {
  const blocks: Record<string, Block> = { ...base.blocks };
  for (const k of e.removed) delete blocks[k];
  Object.assign(blocks, e.put);
  return {
    ...base,
    name: e.name,
    blocks,
    inventory: { ...base.inventory, ...e.inventory },
    player: { ...e.player },
    revision: e.revision,
  };
}

/** 物化链上某个 seq 的完整文档；seq 省略时取链尾。 */
export function materialize(chain: ChainEntry[], seq?: number): WorldDocument {
  const upto = seq === undefined ? chain.length : chain.findIndex((e) => e.seq === seq) + 1;
  if (upto <= 0) throw Error("历史版本不存在");
  let doc: WorldDocument | null = null;
  for (const e of chain.slice(0, upto)) {
    if (e.kind === "snapshot") doc = clone(e.doc);
    else doc = applyDelta(doc!, e);
  }
  return doc!;
}

/**
 * 删除 keep 之外的版本。
 * 被删版本的变更会折叠进保留下来的后继快照/增量，保证保留版本仍可独立读取；
 * 链的最后一个版本始终在 keep 中（调用方负责），因此链条不会断裂。
 */
export function compactChain(
  chain: ChainEntry[],
  keep: Set<number>,
): ChainEntry[] {
  const survivors = chain.filter((e) => keep.has(e.seq));
  const out: ChainEntry[] = [];
  let current: WorldDocument | null = null;
  for (const e of survivors) {
    const doc =
      e.kind === "snapshot"
        ? clone(e.doc)
        : materialize(chain, e.seq);
    if (current === null) {
      out.push({ ...(e as SnapshotEntry), kind: "snapshot", doc: doc! });
    } else if (e.kind === "snapshot") {
      out.push({ ...e, doc: doc! });
    } else {
      const d = diffDocs(current, doc!);
      out.push({ ...(e as DeltaEntry), ...d, kind: "delta" });
    }
    current = doc;
  }
  return out;
}
