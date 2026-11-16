import type { WorldDocument } from "../../../shared/document";
import { encode, decode } from "./codec";
import {
  VAULT_KEY,
  LEGACY_KEY,
  emptyVault,
  type KVStorage,
  type Vault,
} from "./vault-types";

/** 本地存档的软上限：超出后优先清理较早版本。 */
export const QUOTA_BYTES = 3 * 1024 * 1024;

export function bytesOf(vault: Vault): number {
  return new Blob([JSON.stringify(vault)]).size;
}

function browser(): KVStorage {
  return localStorage;
}

export function readVault(kv: KVStorage = browser()): Vault {
  const raw = kv.getItem(VAULT_KEY);
  if (!raw) return emptyVault();
  const v = JSON.parse(raw) as Vault;
  if (!v || v.format !== 2 || typeof v.slots !== "object")
    throw Error("本地存档已损坏");
  return v;
}

export function writeVault(vault: Vault, kv: KVStorage = browser()): void {
  // 单键写入：浏览器对 setItem 是原子提交，失败时旧值保持不变
  kv.setItem(VAULT_KEY, JSON.stringify(vault));
}

export function isQuotaError(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.name === "QuotaExceededError" ||
      e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      e.code === 22)
  );
}

/**
 * 旧版单槽存档升级为可辨认的首个世界。
 * 只有新 vault 写入成功后才删除旧键，失败时旧数据原样保留。
 */
export function migrateLegacy(
  kv: KVStorage = browser(),
  now: number = Date.now(),
): Vault | null {
  const raw = kv.getItem(LEGACY_KEY);
  if (!raw) return null;
  const doc = decode(raw);
  const vault = emptyVault();
  const id = "slot-legacy";
  vault.activeSlotId = id;
  vault.slots[id] = {
    id,
    name: doc.name,
    createdAt: now,
    updatedAt: now,
    headSeq: 1,
    headRevision: doc.revision,
    legacy: true,
    chain: [
      { kind: "snapshot", seq: 1, at: now, label: "旧版存档迁入", doc },
    ],
  };
  writeVault(vault, kv);
  kv.removeItem(LEGACY_KEY);
  return vault;
}

export function downloadWorld(doc: WorldDocument): void {
  const url = URL.createObjectURL(
    new Blob([encode(doc)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${doc.name}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
