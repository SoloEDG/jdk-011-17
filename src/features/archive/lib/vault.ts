import { reactive } from "vue";
import type { WorldDocument } from "../../../shared/document";
import {
  clone,
  compactChain,
  diffDocs,
  isEmptyDelta,
  materialize,
  type ChainEntry,
} from "./chain";
import {
  bytesOf,
  isQuotaError,
  migrateLegacy,
  readVault,
  writeVault,
} from "./storage";
import {
  headDoc,
  metaOf,
  emptyVault,
  type KVStorage,
  type SlotMeta,
  type Vault,
  type VaultSlot,
} from "./vault-types";

/** 每隔多少个增量落一次完整快照，控制重建成本。 */
export const SNAPSHOT_EVERY = 4;
/** 每个槽位默认保留的可恢复版本数。 */
export const MAX_VERSIONS = 10;

export interface SaveOutcome {
  status: "saved" | "noop" | "stale" | "failed";
  slotId: string;
  slotName: string;
  seq: number;
  revision: number;
  pruned: number;
  at: number;
  error?: string;
}

type Flush = (task: () => void) => void;
const defaultFlush: Flush = (task) => setTimeout(task, 150);

/** 深度判断两份世界内容是否一致（revision 之外的字段也参与比较）。 */
export function sameDoc(a: WorldDocument, b: WorldDocument): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class VaultStore {
  vault: Vault = reactive(emptyVault());
  /** 响应式修订计数，每次成功落盘后递增，供 UI 刷新派生数据。 */
  state = reactive({ revision: 0 });
  get revision(): number {
    return this.state.revision;
  }
  /** 每个槽位自载入/切换以来的代数，切换世界即 +1，使迟到写入失效。 */
  private epochs = new Map<string, number>();
  /** 正在写入的槽位，同槽位并发保存直接拒绝。 */
  private inflight = new Set<string>();
  /** 每个槽位当前在途保存的令牌编号；切换/恢复时据此作废旧令牌。 */
  private tokens = new Map<string, number>();
  private kvOverride: KVStorage | null;
  private flush: Flush;
  private clock: () => number;

  private get kv(): KVStorage {
    // 惰性读取，避免在无 localStorage 的环境（测试/SSR）加载模块时报错
    return this.kvOverride ?? localStorage;
  }

  constructor(opts?: { kv?: KVStorage; flush?: Flush; now?: () => number }) {
    this.kvOverride = opts?.kv ?? null;
    this.flush = opts?.flush ?? defaultFlush;
    this.clock = opts?.now ?? (() => Date.now());
  }

  /** 仅供测试：替换底层存储、时钟或刷新策略后重新初始化。 */
  attach(opts: {
    kv?: KVStorage;
    now?: () => number;
    flush?: Flush;
  }): void {
    if (opts.kv) this.kvOverride = opts.kv;
    if (opts.now) this.clock = opts.now;
    if (opts.flush) this.flush = opts.flush;
    this.reset();
  }

  init(): { migrated: boolean } {
    let vault = readVault(this.kv);
    let migrated = false;
    if (Object.keys(vault.slots).length === 0) {
      const legacy = migrateLegacy(this.kv, this.clock());
      if (legacy) {
        vault = legacy;
        migrated = true;
      }
    }
    this.vault = reactive(vault);
    this.state.revision++;
    for (const id of Object.keys(vault.slots)) this.epochs.set(id, 0);
    return { migrated };
  }

  /** 仅供测试：恢复到空库状态。 */
  reset(): void {
    this.vault = reactive(emptyVault());
    this.state.revision++;
    this.epochs.clear();
    this.inflight.clear();
    this.tokens.clear();
  }

  get activeId(): string | null {
    return this.vault.activeSlotId;
  }

  listSlots(): SlotMeta[] {
    return Object.values(this.vault.slots)
      .map(metaOf)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getSlot(id: string): VaultSlot | undefined {
    return this.vault.slots[id];
  }

  bumpEpoch(id: string): number {
    const next = (this.epochs.get(id) ?? 0) + 1;
    this.epochs.set(id, next);
    return next;
  }

  /**
   * 改变激活槽位。
   * invalidateOld=true（切换世界）时令所有非目标槽位的在途令牌失效，
   * 保证离开的世界其迟到写入无法落盘；新建世界时没有在途写入，无需处理。
   */
  private activate(id: string, invalidateOld: boolean): void {
    if (invalidateOld)
      for (const other of this.tokens.keys())
        if (other !== id)
          this.tokens.set(other, (this.tokens.get(other) ?? 0) + 1);
    this.vault.activeSlotId = id;
  }

  /** 创建一个空链槽位（尚未保存的新世界）。 */
  createSlot(name: string): string {
    const id = `slot-${this.clock().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    const now = this.clock();
    this.vault.slots[id] = reactive({
      id,
      name,
      createdAt: now,
      updatedAt: now,
      headSeq: 0,
      headRevision: 0,
      chain: [] as ChainEntry[],
    });
    this.epochs.set(id, 1);
    this.activate(id, false);
    writeVault(this.vault, this.kv);
    return id;
  }

  switchSlot(id: string): WorldDocument {
    const slot = this.vault.slots[id];
    if (!slot) throw Error("世界槽位不存在");
    if (slot.chain.length === 0) throw Error("这个世界还没有保存过");
    this.activate(id, true);
    writeVault(this.vault, this.kv);
    this.bumpEpoch(id);
    return headDoc(slot);
  }

  /**
   * 保存世界。
   * 立即克隆点击时刻的文档并记录槽位令牌，写入被延迟执行：
   * 期间继续建造不会污染本次保存，切换世界后迟到的写入也无法落到新槽位。
   */
  saveSlot(slotId: string, snapshot: WorldDocument): Promise<SaveOutcome> {
    const slot = this.vault.slots[slotId];
    if (!slot)
      return Promise.resolve(this.failed(slotId, "世界槽位不存在", snapshot));
    if (this.inflight.has(slotId))
      return Promise.resolve(
        this.failed(slotId, "上一次保存仍在进行，请稍候", snapshot),
      );
    const epochAtStart = this.epochs.get(slotId) ?? 0;
    const tokenNo = (this.tokens.get(slotId) ?? 0) + 1;
    this.tokens.set(slotId, tokenNo);
    const token = {
      slotId,
      epoch: epochAtStart,
      tokenNo,
      doc: clone(snapshot),
    };
    this.inflight.add(slotId);
    return new Promise((resolve) => {
      this.flush(() => {
        try {
          resolve(this.finishSave(token));
        } catch (e) {
          resolve(
            this.failed(
              token.slotId,
              isQuotaError(e)
                ? "本地空间不足，请清理较早版本或导出备份"
                : "保存失败，请导出备份",
              token.doc,
            ),
          );
        } finally {
          this.inflight.delete(slotId);
        }
      });
    });
  }

  private finishSave(token: {
    slotId: string;
    epoch: number;
    tokenNo: number;
    doc: WorldDocument;
  }): SaveOutcome {
    const slot = this.vault.slots[token.slotId];
    // 切换世界后槽位代数已变化，或该槽位的在途令牌已被切换动作作废
    if (
      !slot ||
      (this.epochs.get(token.slotId) ?? 0) !== token.epoch ||
      (this.tokens.get(token.slotId) ?? 0) !== token.tokenNo
    ) {
      return {
        status: "stale",
        slotId: token.slotId,
        slotName: slot?.name ?? "已删除的世界",
        seq: 0,
        revision: token.doc.revision,
        pruned: 0,
        at: this.clock(),
      };
    }

    const now = this.clock();
    if (
      slot.chain.length > 0 &&
      sameDoc(materialize(slot.chain), token.doc)
    ) {
      return {
        status: "noop",
        slotId: slot.id,
        slotName: slot.name,
        seq: slot.headSeq,
        revision: slot.headRevision,
        pruned: 0,
        at: now,
      };
    }

    const seq = slot.headSeq + 1;
    // 统计自链上最近一个快照之后已积累的增量数，达到节奏点就落新快照
    let deltasSinceSnapshot = 0;
    for (let i = slot.chain.length - 1; i >= 0; i--) {
      if (slot.chain[i].kind === "snapshot") break;
      deltasSinceSnapshot++;
    }
    const entry: ChainEntry =
      slot.chain.length === 0 || deltasSinceSnapshot >= SNAPSHOT_EVERY - 1
        ? { kind: "snapshot", seq, at: now, label: versionLabel(now), doc: token.doc }
        : (() => {
            const d = diffDocs(materialize(slot.chain), token.doc);
            return { ...d, seq, at: now, label: versionLabel(now) };
          })();
    if (entry.kind === "delta" && isEmptyDelta(entry)) {
      return {
        status: "noop",
        slotId: slot.id,
        slotName: slot.name,
        seq: slot.headSeq,
        revision: slot.headRevision,
        pruned: 0,
        at: now,
      };
    }
    slot.chain.push(entry);
    slot.headSeq = seq;
    slot.headRevision = token.doc.revision;
    slot.name = token.doc.name;
    slot.updatedAt = now;
    this.vault.activeSlotId = slot.id;

    const pruned = this.persistWithQuota(slot.id);
    this.state.revision++;
    return {
      status: "saved",
      slotId: slot.id,
      slotName: slot.name,
      seq,
      revision: token.doc.revision,
      pruned,
      at: now,
    };
  }

  /** 写入并在空间不足时清理较早版本；始终保住每个槽位的最新版本。 */
  private persistWithQuota(preferSlot?: string): number {
    let pruned = 0;
    pruned += this.enforceMaxVersions();
    try {
      writeVault(this.vault, this.kv);
    } catch (e) {
      if (!isQuotaError(e)) throw e;
      while (true) {
        const target = this.oldestPrunable(preferSlot);
        if (!target) {
          writeVault(this.vault, this.kv); // 再试一次，不行就向上抛
          break;
        }
        this.dropEntry(target.slotId, target.seq);
        pruned++;
        try {
          writeVault(this.vault, this.kv);
          break;
        } catch (e2) {
          if (!isQuotaError(e2)) throw e2;
        }
      }
    }
    return pruned;
  }

  /** 超出每槽版本上限时，按时间从旧到新折叠（最新版本永不剪）。 */
  private enforceMaxVersions(): number {
    let pruned = 0;
    for (const slot of Object.values(this.vault.slots)) {
      while (slot.chain.length > MAX_VERSIONS && slot.chain.length > 1) {
        this.dropEntry(slot.id, slot.chain[0].seq);
        pruned++;
      }
    }
    return pruned;
  }

  private oldestPrunable(
    preferSlot?: string,
  ): { slotId: string; seq: number } | null {
    let oldest: { slotId: string; seq: number; at: number } | null = null;
    for (const slot of Object.values(this.vault.slots)) {
      // 每个槽位至少保留最后一个可恢复版本
      if (slot.chain.length <= 1) continue;
      const candidate = slot.chain[0];
      const boosted = preferSlot === slot.id ? -1 : 0;
      const at = candidate.at + boosted;
      if (!oldest || at < oldest.at)
        oldest = { slotId: slot.id, seq: candidate.seq, at };
    }
    return oldest ? { slotId: oldest.slotId, seq: oldest.seq } : null;
  }

  /**
   * 删除一个版本：把它的变更折叠进后继条目，
   * 后继版本依然完整可读，不会因为删了中间版本而断链。
   */
  private dropEntry(slotId: string, seq: number): void {
    const slot = this.vault.slots[slotId];
    if (!slot || slot.chain.length <= 1) return;
    const keep = new Set(slot.chain.map((e) => e.seq).filter((s) => s !== seq));
    slot.chain = compactChain(slot.chain, keep);
    slot.headSeq = slot.chain[slot.chain.length - 1].seq;
    slot.updatedAt = Math.max(slot.updatedAt, slot.chain.at(-1)!.at);
  }

  /** 用户手动清理指定版本，返回是否删除成功。 */
  purgeVersion(slotId: string, seq: number): boolean {
    const slot = this.vault.slots[slotId];
    if (!slot || slot.chain.length <= 1) return false;
    if (!slot.chain.some((e) => e.seq === seq)) return false;
    this.dropEntry(slotId, seq);
    writeVault(this.vault, this.kv);
    this.state.revision++;
    this.bumpEpoch(slotId);
    return true;
  }

  restoreVersion(slotId: string, seq: number): WorldDocument {
    const slot = this.vault.slots[slotId];
    if (!slot) throw Error("世界槽位不存在");
    const doc = materialize(slot.chain, seq);
    this.activate(slotId, true);
    writeVault(this.vault, this.kv);
    this.bumpEpoch(slotId);
    return doc;
  }

  exportVersion(slotId: string, seq?: number): WorldDocument {
    const slot = this.vault.slots[slotId];
    if (!slot) throw Error("世界槽位不存在");
    return materialize(slot.chain, seq);
  }

  /** 导入的独立文件总是成为一个新槽位，绝不覆盖现有世界。 */
  importSlot(doc: WorldDocument): string {
    const base = doc.name;
    let name = base;
    const existing = new Set(Object.values(this.vault.slots).map((s) => s.name));
    let n = 2;
    while (existing.has(name)) name = `${base}（${n++}）`;
    const id = this.createSlot(name);
    const slot = this.vault.slots[id];
    const now = this.clock();
    slot.chain = [
      { kind: "snapshot", seq: 1, at: now, label: "导入的世界", doc },
    ];
    slot.headSeq = 1;
    slot.headRevision = doc.revision;
    slot.updatedAt = now;
    writeVault(this.vault, this.kv);
    this.state.revision++;
    return id;
  }

  private failed(
    slotId: string,
    error: string,
    doc: WorldDocument,
  ): SaveOutcome {
    return {
      status: "failed",
      slotId,
      slotName: this.vault.slots[slotId]?.name ?? doc.name,
      seq: 0,
      revision: doc.revision,
      pruned: 0,
      at: this.clock(),
      error,
    };
  }

  bytesUsed(): number {
    return bytesOf(this.vault);
  }
}

export function versionLabel(at: number): string {
  return new Date(at).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
