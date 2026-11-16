<script setup lang="ts">
import { computed, ref } from "vue";
import {
  Save,
  FolderOpen,
  Download,
  Upload,
  HardDrive,
  Plus,
  History,
  RotateCcw,
  Check,
  Trash2,
  Layers,
  Database,
} from "lucide-vue-next";
import type { Workspace } from "../../../shared/document";
import {
  save,
  load,
  switchWorld,
  createNewWorld,
  restoreVersion,
  cancelLoad,
  dismissPending,
  purgeVersion,
  exportWorld,
  exportVersion,
  importWorld,
  listSlots,
  isDirty,
  store,
} from "../index";
import { versionLabel } from "../lib/vault";
import { QUOTA_BYTES } from "../lib/storage";

const props = defineProps<{ state: Workspace }>();
const input = ref<HTMLInputElement>();
const showHistory = ref(true);

const slots = computed(() => listSlots());
const currentSlot = computed(() => store.getSlot(props.state.slotId));
const versions = computed(() =>
  currentSlot.value ? [...currentSlot.value.chain].reverse() : [],
);
// 依赖 store.revision，保证保存/清理后空间占用条随之刷新
const usage = computed(() => {
  void store.revision;
  return Math.min(100, Math.round((store.bytesUsed() / QUOTA_BYTES) * 100));
});
const dirty = computed(() => isDirty(props.state));

function choose(e: Event) {
  const el = e.target as HTMLInputElement;
  const f = el.files?.[0];
  if (f) void importWorld(props.state, f);
  el.value = "";
}
function fmt(at: number) {
  return versionLabel(at);
}
</script>

<template>
  <section class="panel archive">
    <div class="section-title">
      <h2>世界存档</h2>
      <HardDrive :size="17" />
    </div>

    <div class="save-state">
      <i class="status-dot" :class="{ warn: dirty }"></i>
      <span>{{
        dirty
          ? "有未保存的更改"
          : state.savedAt
            ? "已保存 · " + state.savedAt
            : "新现场，尚未保存"
      }}</span>
    </div>

    <div class="row">
      <button class="soft" @click="save(state)">
        <Save :size="14" />保存
      </button>
      <button class="soft" @click="load(state)">
        <FolderOpen :size="14" />重载
      </button>
    </div>

    <div
      v-if="state.pendingLoad"
      class="pending-banner"
      role="alert"
    >
      <b>已载入其他现场</b>
      <span>原世界、选区与库存已保留，可随时撤回「{{
        state.pendingLoad.title
      }}」</span>
      <div class="row">
        <button class="soft" @click="cancelLoad(state)">
          <RotateCcw :size="13" />撤回载入
        </button>
        <button class="soft" @click="dismissPending(state)">
          <Check :size="13" />确认
        </button>
      </div>
    </div>

    <div class="sub-title">
      <Layers :size="13" /><span>世界槽位（{{ slots.length }}）</span>
    </div>
    <div class="slot-list">
      <button
        v-for="slot in slots"
        :key="slot.id"
        class="slot-item"
        :class="{ active: slot.id === state.slotId }"
        @click="switchWorld(state, slot.id)"
      >
        <div class="slot-main">
          <b>{{ slot.name }}</b>
          <small>
            <span v-if="slot.legacy" class="legacy-tag">旧版迁入</span>
            <span v-if="slot.versions === 0" class="unsaved-tag">未保存</span>
            {{ slot.versions }} 个版本 · {{ fmt(slot.updatedAt) }}
          </small>
        </div>
        <Check v-if="slot.id === state.slotId" :size="14" class="slot-check" />
      </button>
      <p v-if="slots.length === 0" class="muted small slot-empty">
        还没有本地世界，保存后会出现在这里
      </p>
    </div>
    <button class="soft full new-world" @click="createNewWorld(state)">
      <Plus :size="14" />新建世界
    </button>

    <div class="sub-title history-title" @click="showHistory = !showHistory">
      <History :size="13" /><span>可恢复的历史版本</span>
      <em>{{ versions.length }}</em>
    </div>
    <div v-if="showHistory" class="version-list">
      <div
        v-for="(v, i) in versions"
        :key="v.seq"
        class="version-item"
        :class="{ head: i === 0 }"
      >
        <div class="version-meta">
          <b>#{{ v.seq }} {{ v.label }}</b>
          <small>
            {{ v.kind === "snapshot" ? "完整快照" : "增量" }} · 修订
            {{ v.kind === "snapshot" ? v.doc.revision : v.revision }}
          </small>
        </div>
        <div class="version-actions">
          <button
            class="icon-btn"
            title="恢复此版本"
            :disabled="i === 0"
            @click="restoreVersion(state, v.seq)"
          >
            <RotateCcw :size="13" />
          </button>
          <button
            class="icon-btn"
            title="导出为独立文件"
            @click="exportVersion(state, v.seq)"
          >
            <Download :size="13" />
          </button>
          <button
            class="icon-btn danger"
            title="清理此版本（最新版本受保护）"
            :disabled="i === 0"
            @click="purgeVersion(state, v.seq)"
          >
            <Trash2 :size="13" />
          </button>
        </div>
      </div>
      <p v-if="versions.length === 0" class="muted small">
        保存后会生成第一个历史版本
      </p>
    </div>

    <div class="quota">
      <div class="quota-head">
        <Database :size="12" /><span>本地空间 {{ usage }}%</span>
      </div>
      <div class="quota-bar"><i :style="{ width: usage + '%' }"></i></div>
      <small>空间不足时自动清理较早版本，最新版本始终保留</small>
    </div>

    <div class="row">
      <button class="text-btn" @click="exportWorld(state)">
        <Download :size="14" />导出世界
      </button>
      <button class="text-btn" @click="input?.click()">
        <Upload :size="14" />导入
      </button>
    </div>
    <input ref="input" type="file" accept=".json" hidden @change="choose" />
  </section>
</template>
