import type {
  PendingSession,
  Region,
  Tool,
  Workspace,
  WorldDocument,
} from "../../../shared/document";
import { createWorld } from "../../world";
import { decode } from "../lib/codec";
import { clone } from "../lib/chain";
import { downloadWorld } from "../lib/storage";
import { VaultStore, timeLabel, type SaveOutcome } from "../lib/vault";
import type { SlotMeta } from "../lib/vault-types";

export const store = new VaultStore();

function snapshotSession(s: Workspace, title: string): PendingSession {
  return {
    slotId: s.slotId,
    title,
    doc: clone(s.doc),
    material: s.material,
    tool: s.tool,
    region: s.region ? clone(s.region) : null,
    anchor: s.anchor ? { ...s.anchor } : null,
    mode: s.mode,
    savedRevision: s.savedRevision,
    savedAt: s.savedAt,
  };
}

function installDoc(s: Workspace, doc: WorldDocument, slotId: string): void {
  const epoch = store.bumpEpoch(slotId);
  const revision = s.doc.revision + 1;
  s.doc = doc;
  s.doc.revision = revision;
  s.slotId = slotId;
  s.savedRevision = revision;
  s.loadEpoch = epoch;
  s.dirty = false;
  s.region = null;
  s.anchor = null;
  // 注意：pendingLoad 由调用方决定是否保留（载入/切换/恢复需要可撤回）
  s.savedAt = timeLabel(Date.now());
}

export function initArchive(s: Workspace): void {
  const { migrated } = store.init();
  const slots = store.listSlots();
  if (slots.length === 0) return;
  const active =
    (store.activeId && store.getSlot(store.activeId)) ||
    Object.values(store.vault.slots)[0];
  if (!active || active.chain.length === 0) return;
  installDoc(s, store.exportVersion(active.id), active.id);
  s.pendingLoad = null;
  s.message = migrated
    ? `旧版单槽存档已升级为首个世界「${active.name}」`
    : `已载入世界「${active.name}」`;
}

export function isDirty(s: Workspace): boolean {
  return s.doc.revision !== s.savedRevision || s.dirty;
}

/**
 * 保存当前世界。
 * 点击时刻立即克隆文档快照，写入在后台延迟执行：
 * 期间继续建造不会进入本次保存，完成提示只描述实际写入的那个版本。
 */
export function save(s: Workspace): Promise<void> {
  const slotId = s.slotId;
  const snapshot = clone(s.doc);
  const revisionAtClick = snapshot.revision;
  s.message = "正在保存世界…";
  return store.saveSlot(slotId, snapshot).then((out) => {
    applyOutcome(s, out, revisionAtClick);
  });
}

function applyOutcome(
  s: Workspace,
  out: SaveOutcome,
  revisionAtClick: number,
): void {
  if (out.status === "stale") {
    // 世界已切换：迟到写入在 store 内已被拒绝，当前槽位不受影响
    s.message = "世界已切换，那次保存未写入任何槽位";
    return;
  }
  if (out.status === "failed") {
    s.message = out.error ?? "保存失败，请导出备份";
    return;
  }
  if (out.status === "noop") {
    s.savedAt = timeLabel(out.at);
    s.savedRevision = s.doc.revision;
    s.dirty = false;
    s.message = "没有新的改动，世界已是最新存档";
    return;
  }
  // 保存期间用户切换了世界：写入落在旧槽位，绝不覆盖当前新槽位
  if (s.slotId !== out.slotId) {
    s.message = `世界「${out.slotName}」的旧保存已完成，但未影响当前世界`;
    return;
  }
  s.savedAt = timeLabel(out.at);
  s.savedRevision = revisionAtClick;
  // 保存过程中新增的建造保留在工作区，但不会被标记为已保存
  s.dirty = s.doc.revision !== revisionAtClick;
  const pruneNote = out.pruned
    ? `（已自动清理 ${out.pruned} 个较早版本）`
    : "";
  s.message = s.dirty
    ? `已保存第 ${out.seq} 个历史版本；保存后的新建造尚未保存${pruneNote}`
    : `世界已保存为第 ${out.seq} 个历史版本${pruneNote}`;
}

/** 重新载入当前槽位最近一次保存的状态。 */
export function load(s: Workspace): void {
  const slot = store.getSlot(s.slotId);
  if (!slot || slot.chain.length === 0) {
    s.message = "这个世界还没有保存过，先点一次保存";
    return;
  }
  if (isDirty(s) && !s.pendingLoad)
    s.pendingLoad = snapshotSession(s, "重新载入当前世界");
  installDoc(s, store.exportVersion(s.slotId), s.slotId);
  s.message = "已回到当前世界最近一次保存的状态，可撤回";
}

export function switchWorld(s: Workspace, slotId: string): void {
  if (slotId === s.slotId) return;
  const target = store.getSlot(slotId);
  if (!target) {
    s.message = "世界槽位不存在";
    return;
  }
  if (target.chain.length === 0) {
    s.message = `「${target.name}」还没有保存过，无法载入`;
    return;
  }
  if (isDirty(s) && !s.pendingLoad)
    s.pendingLoad = snapshotSession(s, "切换世界前的现场");
  installDoc(s, store.switchSlot(slotId), slotId);
  s.message = `已切换到世界「${target.name}」，可撤回`;
}

export function createNewWorld(s: Workspace): void {
  if (isDirty(s) && !s.pendingLoad)
    s.pendingLoad = snapshotSession(s, "新建世界前的现场");
  const id = store.createSlot(`新世界 ${store.listSlots().length + 1}`);
  const doc = createWorld();
  doc.name = "空白世界";
  doc.revision = 0;
  installDoc(s, doc, id);
  s.message = "已创建新世界，第一次建造后记得保存";
}

export function restoreVersion(s: Workspace, seq: number): void {
  if (isDirty(s) && !s.pendingLoad)
    s.pendingLoad = snapshotSession(s, `恢复版本 #${seq} 前的现场`);
  const doc = store.restoreVersion(s.slotId, seq);
  installDoc(s, doc, s.slotId);
  s.message = `已恢复到历史版本 #${seq}，可在下方撤回`;
}

/** 撤回载入/切换/恢复：原世界、选区、库存原样回来。 */
export function cancelLoad(s: Workspace): void {
  const p = s.pendingLoad;
  if (!p) return;
  installSession(s, p);
  s.message = "已撤回载入决定，原世界、选区和库存都回来了";
}

export function dismissPending(s: Workspace): void {
  s.pendingLoad = null;
  s.message = "已确认载入，撤回入口已关闭";
}

function installSession(s: Workspace, p: PendingSession): void {
  const epoch = store.bumpEpoch(p.slotId);
  s.doc = p.doc;
  s.material = p.material;
  s.tool = p.tool as Tool;
  s.region = p.region as Region | null;
  s.anchor = p.anchor;
  s.mode = p.mode;
  s.slotId = p.slotId;
  s.savedRevision = p.savedRevision;
  s.savedAt = p.savedAt;
  s.loadEpoch = epoch;
  s.dirty = false;
  s.pendingLoad = null;
  if (store.activeId !== p.slotId && store.getSlot(p.slotId))
    store.vault.activeSlotId = p.slotId;
}

/** 用户手动清理较早版本；最新版本受保护。 */
export function purgeVersion(s: Workspace, seq: number): void {
  const ok = store.purgeVersion(s.slotId, seq);
  s.message = ok
    ? `历史版本 #${seq} 已清理，其余版本仍可正常读取`
    : "最新版本不可清理，或该版本不存在";
}

export function exportWorld(s: Workspace): void {
  const slot = store.getSlot(s.slotId);
  const doc = slot && slot.chain.length > 0 ? store.exportVersion(s.slotId) : s.doc;
  downloadWorld(doc);
  s.message = "世界文件已导出（独立单文件，可在其他浏览器导入）";
}

export function exportVersion(s: Workspace, seq: number): void {
  downloadWorld(store.exportVersion(s.slotId, seq));
  s.message = `历史版本 #${seq} 已导出为独立文件`;
}

export async function importWorld(s: Workspace, file: File): Promise<void> {
  try {
    const doc = decode(await file.text());
    if (isDirty(s) && !s.pendingLoad)
      s.pendingLoad = snapshotSession(s, "导入前的现场");
    const id = store.importSlot(doc);
    installDoc(s, clone(doc), id);
    s.message = `已导入为新世界「${doc.name}」，原有槽位均未改动`;
  } catch (e) {
    s.message = (e as Error).message;
  }
}

export function listSlots(): SlotMeta[] {
  return store.listSlots();
}
