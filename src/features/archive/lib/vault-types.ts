import type { WorldDocument } from "../../../shared/document";
import { materialize, type ChainEntry } from "./chain";

export interface SlotMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  headSeq: number;
  headRevision: number;
  /** 派生字段：链上的版本数 */
  versions: number;
  legacy?: boolean;
}
export interface VaultSlot {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  headSeq: number;
  headRevision: number;
  legacy?: boolean;
  chain: ChainEntry[];
}
export interface Vault {
  format: 2;
  activeSlotId: string | null;
  slots: Record<string, VaultSlot>;
}

export interface KVStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const VAULT_KEY = "blockhaven-vault-v2";
export const LEGACY_KEY = "blockhaven-world-v1";

export function emptyVault(): Vault {
  return { format: 2, activeSlotId: null, slots: {} };
}

export function metaOf(slot: VaultSlot): SlotMeta {
  return {
    id: slot.id,
    name: slot.name,
    createdAt: slot.createdAt,
    updatedAt: slot.updatedAt,
    headSeq: slot.headSeq,
    headRevision: slot.headRevision,
    versions: slot.chain.length,
    legacy: slot.legacy,
  };
}

export function headDoc(slot: VaultSlot): WorldDocument {
  return materialize(slot.chain);
}
