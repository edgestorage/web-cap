<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ScriptExecutionHistoryEntry } from '@shared/protocol';
import type { ScriptDefinition, ScriptType, UserScriptDefinition } from '@shared/script-schema';

const SCRIPT_HISTORY_STORAGE_KEY = 'scriptExecutionHistory';
const SCRIPT_HISTORY_UPDATED_AT_STORAGE_KEY = 'scriptExecutionHistoryUpdatedAt';
const SCRIPT_REGISTRY_STORAGE_KEY = 'scriptRegistry';
const SCRIPT_REGISTRY_UPDATED_AT_STORAGE_KEY = 'scriptRegistryUpdatedAt';
const USERSCRIPT_REGISTRY_STORAGE_KEY = 'userScriptRegistry';
const USERSCRIPT_REGISTRY_UPDATED_AT_STORAGE_KEY = 'userScriptRegistryUpdatedAt';
const USERSCRIPT_AVAILABLE_STORAGE_KEY = 'userScriptsAvailable';

const entries = ref<ScriptExecutionHistoryEntry[]>([]);
const scripts = ref<ScriptDefinition[]>([]);
const userScripts = ref<UserScriptDefinition[]>([]);
const updatedAt = ref('');
const registryUpdatedAt = ref('');
const userScriptUpdatedAt = ref('');
const userScriptsAvailable = ref(false);
const isLoading = ref(true);
const activeView = ref<'registry' | 'userscripts' | 'history'>('registry');
const scriptTypeFilter = ref<'all' | ScriptType>('all');
const expandedScripts = ref<string[]>([]);
const dialogTitle = ref('');
const dialogContent = ref('');

const visibleEntries = computed(() => entries.value.slice(0, 12));
const registeredScripts = computed(() =>
  scripts.value.filter((script) => !script.id.startsWith('temp.script.')),
);
const filteredScripts = computed(() => {
  return registeredScripts.value
    .filter((script) => scriptTypeFilter.value === 'all' || script.type === scriptTypeFilter.value)
    .slice(0, 30);
});

const summary = computed(() => {
  const running = entries.value.filter((entry) => entry.status === 'running').length;
  const failed = entries.value.filter((entry) => entry.status === 'failed').length;
  const succeeded = entries.value.filter((entry) => entry.status === 'succeeded').length;
  return { running, failed, succeeded };
});

const registrySummary = computed(() => {
  const builtIn = registeredScripts.value.filter((script) => script.id.startsWith('builtin.')).length;
  const registered = registeredScripts.value.length - builtIn;
  return { builtIn, registered, total: registeredScripts.value.length };
});

const userScriptSummary = computed(() => {
  const active = userScripts.value.filter((script) => script.status === 'active').length;
  const disabled = userScripts.value.filter((script) => script.status === 'disabled').length;
  return { active, disabled, total: userScripts.value.length };
});

const lastUpdatedLabel = computed(() => {
  if (!updatedAt.value) {
    return 'Waiting for the first sync from MCP';
  }

  const date = new Date(updatedAt.value);
  return Number.isNaN(date.getTime()) ? updatedAt.value : date.toLocaleString();
});

const registryUpdatedLabel = computed(() => {
  if (!registryUpdatedAt.value) {
    return 'Waiting for registry sync from MCP';
  }

  const date = new Date(registryUpdatedAt.value);
  return Number.isNaN(date.getTime()) ? registryUpdatedAt.value : date.toLocaleString();
});

const userScriptUpdatedLabel = computed(() => {
  if (!userScriptUpdatedAt.value) {
    return 'Not synced yet';
  }

  const date = new Date(userScriptUpdatedAt.value);
  return Number.isNaN(date.getTime()) ? userScriptUpdatedAt.value : date.toLocaleString();
});

function formatJson(value: Record<string, unknown> | undefined): string {
  if (!value || Object.keys(value).length === 0) {
    return '{}';
  }

  return JSON.stringify(value, null, 2);
}

function formatSchema(script: ScriptDefinition): string {
  return JSON.stringify(
    {
      inputSchema: script.inputSchema,
      outputSchema: script.outputSchema,
    },
    null,
    2,
  );
}

function sourceLabel(scriptId: string): string {
  if (scriptId.startsWith('builtin.')) {
    return 'Built-in';
  }
  if (scriptId.startsWith('local.')) {
    return 'Local';
  }
  return 'Registry';
}

function isScriptExpanded(localScriptId: string): boolean {
  return expandedScripts.value.includes(localScriptId);
}

function toggleScript(localScriptId: string): void {
  if (isScriptExpanded(localScriptId)) {
    expandedScripts.value = expandedScripts.value.filter((id) => id !== localScriptId);
    return;
  }

  expandedScripts.value = [...expandedScripts.value, localScriptId];
}

function openDialog(title: string, content: string): void {
  dialogTitle.value = title;
  dialogContent.value = content;
}

function closeDialog(): void {
  dialogTitle.value = '';
  dialogContent.value = '';
}

async function loadHistory(): Promise<void> {
  isLoading.value = true;

  try {
    const stored = await browser.storage.local.get([
      SCRIPT_HISTORY_STORAGE_KEY,
      SCRIPT_HISTORY_UPDATED_AT_STORAGE_KEY,
      SCRIPT_REGISTRY_STORAGE_KEY,
      SCRIPT_REGISTRY_UPDATED_AT_STORAGE_KEY,
      USERSCRIPT_REGISTRY_STORAGE_KEY,
      USERSCRIPT_REGISTRY_UPDATED_AT_STORAGE_KEY,
      USERSCRIPT_AVAILABLE_STORAGE_KEY,
    ]);

    entries.value = Array.isArray(stored[SCRIPT_HISTORY_STORAGE_KEY])
      ? (stored[SCRIPT_HISTORY_STORAGE_KEY] as ScriptExecutionHistoryEntry[])
      : [];
    scripts.value = Array.isArray(stored[SCRIPT_REGISTRY_STORAGE_KEY])
      ? (stored[SCRIPT_REGISTRY_STORAGE_KEY] as ScriptDefinition[])
      : [];
    userScripts.value = Array.isArray(stored[USERSCRIPT_REGISTRY_STORAGE_KEY])
      ? (stored[USERSCRIPT_REGISTRY_STORAGE_KEY] as UserScriptDefinition[])
      : [];
    updatedAt.value =
      typeof stored[SCRIPT_HISTORY_UPDATED_AT_STORAGE_KEY] === 'string'
        ? stored[SCRIPT_HISTORY_UPDATED_AT_STORAGE_KEY]
        : '';
    registryUpdatedAt.value =
      typeof stored[SCRIPT_REGISTRY_UPDATED_AT_STORAGE_KEY] === 'string'
        ? stored[SCRIPT_REGISTRY_UPDATED_AT_STORAGE_KEY]
        : '';
    userScriptUpdatedAt.value =
      typeof stored[USERSCRIPT_REGISTRY_UPDATED_AT_STORAGE_KEY] === 'string'
        ? stored[USERSCRIPT_REGISTRY_UPDATED_AT_STORAGE_KEY]
        : '';
    userScriptsAvailable.value = stored[USERSCRIPT_AVAILABLE_STORAGE_KEY] === true;
  } finally {
    isLoading.value = false;
  }
}

function handleStorageChanged(
  changes: Record<string, browser.storage.StorageChange>,
  areaName: string,
): void {
  if (areaName !== 'local') {
    return;
  }

  const historyChange = changes[SCRIPT_HISTORY_STORAGE_KEY];
  if (historyChange) {
    entries.value = Array.isArray(historyChange.newValue)
      ? (historyChange.newValue as ScriptExecutionHistoryEntry[])
      : [];
    expandedScripts.value = expandedScripts.value.filter((id) =>
      entries.value.some((entry) => entry.localScriptId === id),
    );
  }

  const updatedAtChange = changes[SCRIPT_HISTORY_UPDATED_AT_STORAGE_KEY];
  if (updatedAtChange) {
    updatedAt.value = typeof updatedAtChange.newValue === 'string' ? updatedAtChange.newValue : '';
  }

  const registryChange = changes[SCRIPT_REGISTRY_STORAGE_KEY];
  if (registryChange) {
    scripts.value = Array.isArray(registryChange.newValue)
      ? (registryChange.newValue as ScriptDefinition[])
      : [];
  }

  const registryUpdatedAtChange = changes[SCRIPT_REGISTRY_UPDATED_AT_STORAGE_KEY];
  if (registryUpdatedAtChange) {
    registryUpdatedAt.value =
      typeof registryUpdatedAtChange.newValue === 'string'
        ? registryUpdatedAtChange.newValue
        : '';
  }

  const userScriptChange = changes[USERSCRIPT_REGISTRY_STORAGE_KEY];
  if (userScriptChange) {
    userScripts.value = Array.isArray(userScriptChange.newValue)
      ? (userScriptChange.newValue as UserScriptDefinition[])
      : [];
  }

  const userScriptUpdatedAtChange = changes[USERSCRIPT_REGISTRY_UPDATED_AT_STORAGE_KEY];
  if (userScriptUpdatedAtChange) {
    userScriptUpdatedAt.value =
      typeof userScriptUpdatedAtChange.newValue === 'string'
        ? userScriptUpdatedAtChange.newValue
        : '';
  }

  const userScriptsAvailableChange = changes[USERSCRIPT_AVAILABLE_STORAGE_KEY];
  if (userScriptsAvailableChange) {
    userScriptsAvailable.value = userScriptsAvailableChange.newValue === true;
  }
}

onMounted(async () => {
  await loadHistory();
  browser.storage.onChanged.addListener(handleStorageChanged);
});

onBeforeUnmount(() => {
  browser.storage.onChanged.removeListener(handleStorageChanged);
});
</script>

<template>
  <main class="app">
    <section class="hero">
      <p class="eyebrow">WEB_CAP</p>
      <h1>Script Registry</h1>
      <p class="copy">Browse callable scripts synced from the local runtime.</p>
    </section>

    <nav class="view-switch" aria-label="Popup views">
      <button
        type="button"
        :class="{ active: activeView === 'registry' }"
        @click="activeView = 'registry'"
      >
        Registered
      </button>
      <button
        type="button"
        :class="{ active: activeView === 'userscripts' }"
        @click="activeView = 'userscripts'"
      >
        Userscripts
      </button>
      <button
        type="button"
        :class="{ active: activeView === 'history' }"
        @click="activeView = 'history'"
      >
        Runs
      </button>
    </nav>

    <section v-if="activeView === 'registry'" class="stats registry-stats">
      <article class="stat-card">
        <span class="stat-label">Registry</span>
        <strong>{{ registrySummary.registered }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">Built-in</span>
        <strong>{{ registrySummary.builtIn }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">Total</span>
        <strong>{{ registrySummary.total }}</strong>
      </article>
    </section>

    <section v-else-if="activeView === 'userscripts'" class="stats">
      <article class="stat-card">
        <span class="stat-label">Active</span>
        <strong>{{ userScriptSummary.active }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">Disabled</span>
        <strong>{{ userScriptSummary.disabled }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">Total</span>
        <strong>{{ userScriptSummary.total }}</strong>
      </article>
    </section>

    <section v-else class="stats">
      <article class="stat-card">
        <span class="stat-label">Succeeded</span>
        <strong>{{ summary.succeeded }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">Running</span>
        <strong>{{ summary.running }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">Failed</span>
        <strong>{{ summary.failed }}</strong>
      </article>
    </section>

    <section class="meta">
      <span class="meta-label">Last sync</span>
      <span class="meta-value">{{
        activeView === 'registry'
          ? registryUpdatedLabel
          : activeView === 'userscripts'
            ? userScriptUpdatedLabel
            : lastUpdatedLabel
      }}</span>
    </section>

    <section v-if="isLoading" class="empty-state">
      <p>Loading cached data...</p>
    </section>

    <section v-else-if="activeView === 'registry'" class="registry-panel">
      <div class="toolbar">
        <select v-model="scriptTypeFilter" aria-label="Script type">
          <option value="all">All types</option>
          <option value="read">Read</option>
          <option value="act">Act</option>
        </select>
      </div>

      <section v-if="filteredScripts.length === 0" class="empty-state">
        <p>No registered scripts found.</p>
        <p class="hint">Connect the local runtime or clear the type filter.</p>
      </section>

      <section v-else class="registry-list">
        <article v-for="script in filteredScripts" :key="`${script.id}@${script.version}`" class="script-card">
          <header class="script-card-header">
            <div>
              <p class="script-name">{{ script.name }}</p>
              <p class="script-id">{{ script.id }}@{{ script.version }}</p>
            </div>
            <div class="pill-stack">
              <span class="status-pill">{{ script.type }}</span>
              <span class="status-pill" :data-status="script.status">{{ script.status }}</span>
            </div>
          </header>

          <p class="script-summary">{{ script.summary }}</p>

          <div class="script-meta-row">
            <span>{{ sourceLabel(script.id) }}</span>
            <span>{{ script.target.site }}</span>
          </div>

          <div v-if="script.tags.length > 0" class="tag-row">
            <span v-for="tag in script.tags" :key="tag">{{ tag }}</span>
          </div>

          <div class="script-actions">
            <button
              type="button"
              class="ghost-button"
              @click="openDialog(`${script.id} · Schema`, formatSchema(script))"
            >
              Schema
            </button>
            <button
              type="button"
              class="ghost-button"
              @click="openDialog(`${script.id} · Code`, script.script.code)"
            >
              Code
            </button>
          </div>
        </article>
      </section>
    </section>

    <section v-else-if="activeView === 'userscripts'" class="registry-panel">
      <section v-if="!userScriptsAvailable" class="notice-card">
        <p class="notice-title">User scripts support is not enabled.</p>
        <p class="hint">Enable the extension's user scripts support and reconnect the runtime.</p>
      </section>

      <section v-if="userScripts.length === 0" class="empty-state">
        <p>No userscripts installed.</p>
        <p class="hint">Install one with the Web Cap CLI.</p>
      </section>

      <section v-else class="registry-list">
        <article v-for="script in userScripts" :key="`${script.id}@${script.version}`" class="script-card">
          <header class="script-card-header">
            <div>
              <p class="script-name">{{ script.name }}</p>
              <p class="script-id">{{ script.id }}@{{ script.version }}</p>
            </div>
            <div class="pill-stack">
              <span class="status-pill">{{ script.runAt }}</span>
              <span class="status-pill" :data-status="script.status">{{ script.status }}</span>
            </div>
          </header>

          <div class="script-meta-row">
            <span>{{ script.matches.length }} match{{ script.matches.length === 1 ? '' : 'es' }}</span>
            <span>{{ script.sourcePath || 'Cached userscript' }}</span>
          </div>

          <div class="tag-row">
            <span v-for="match in script.matches" :key="match">{{ match }}</span>
          </div>

          <div class="script-actions">
            <button
              type="button"
              class="ghost-button"
              @click="openDialog(`${script.id} · Matches`, script.matches.join('\n'))"
            >
              Matches
            </button>
            <button
              type="button"
              class="ghost-button"
              @click="openDialog(`${script.id} · Code`, script.code)"
            >
              Code
            </button>
          </div>
        </article>
      </section>
    </section>

    <section v-else-if="visibleEntries.length === 0" class="empty-state">
      <p>No script executions yet.</p>
      <p class="hint">Run `script_execute` once and the popup will start listing them here.</p>
    </section>

    <section v-else class="history-list">
      <article v-for="entry in visibleEntries" :key="entry.localScriptId" class="history-card">
        <header class="history-header">
          <div>
            <p class="script-id">{{ entry.localScriptId }}</p>
            <p class="script-time">{{ new Date(entry.updatedAt).toLocaleString() }}</p>
          </div>
          <span class="status-pill" :data-status="entry.status">{{ entry.status }}</span>
        </header>

        <section class="script-block">
          <div class="section-head">
            <h2>Script</h2>
            <button type="button" class="ghost-button" @click="toggleScript(entry.localScriptId)">
              {{ isScriptExpanded(entry.localScriptId) ? 'Collapse' : 'Expand' }}
            </button>
          </div>
          <pre :class="{ 'preview-script-pre': !isScriptExpanded(entry.localScriptId) }">{{ entry.script }}</pre>
        </section>

        <div class="io-grid">
          <section>
            <div class="section-head">
              <h2>Input</h2>
              <button
                type="button"
                class="ghost-button"
                @click="openDialog(`${entry.localScriptId} · Input`, formatJson(entry.input))"
              >
                Open
              </button>
            </div>
            <pre class="preview-pre">{{ formatJson(entry.input) }}</pre>
          </section>
          <section v-if="entry.execution?.result">
            <div class="section-head">
              <h2>Result</h2>
              <button
                type="button"
                class="ghost-button"
                @click="openDialog(`${entry.localScriptId} · Result`, formatJson(entry.execution?.result))"
              >
                Open
              </button>
            </div>
            <pre class="preview-pre">{{ formatJson(entry.execution.result) }}</pre>
          </section>
          <section v-else-if="entry.error">
            <div class="section-head">
              <h2>Error</h2>
              <button
                type="button"
                class="ghost-button"
                @click="openDialog(`${entry.localScriptId} · Error`, entry.error.code ? `${entry.error.code}: ${entry.error.message}` : entry.error.message)"
              >
                Open
              </button>
            </div>
            <pre class="preview-pre">{{ entry.error.code ? `${entry.error.code}: ${entry.error.message}` : entry.error.message }}</pre>
          </section>
        </div>
      </article>
    </section>

    <div v-if="dialogTitle" class="dialog-backdrop" @click.self="closeDialog">
      <section class="dialog-panel">
        <div class="dialog-header">
          <h2 class="dialog-title">{{ dialogTitle }}</h2>
          <button type="button" class="ghost-button" @click="closeDialog">Close</button>
        </div>
        <pre class="dialog-pre">{{ dialogContent }}</pre>
      </section>
    </div>
  </main>
</template>

<style scoped>
:global(:root) {
  color-scheme: light;
  font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
  background:
    radial-gradient(circle at top right, rgba(255, 206, 125, 0.6), transparent 34%),
    radial-gradient(circle at top left, rgba(74, 144, 226, 0.2), transparent 36%),
    linear-gradient(180deg, #fbf7f1 0%, #f3efe7 100%);
  background-attachment: fixed;
  background-repeat: no-repeat;
  background-size: cover;
  color: #1f1c17;
}

:global(body) {
  margin: 0;
  min-width: 420px;
  min-height: 100vh;
}

.app {
  padding: 18px;
}

.hero {
  margin-bottom: 14px;
}

.eyebrow {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #8a4b14;
}

h1 {
  margin: 0;
  font-size: 28px;
  line-height: 1;
}

.copy {
  margin: 8px 0 0;
  color: #5f5546;
  line-height: 1.45;
}

.view-switch {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}

.view-switch button {
  border: 1px solid rgba(62, 91, 128, 0.22);
  border-radius: 8px;
  padding: 9px 10px;
  background: rgba(255, 255, 255, 0.62);
  color: #435468;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.view-switch button.active {
  border-color: #2f6f9f;
  background: #e8f2f8;
  color: #174c70;
}

.stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.stat-card,
.meta,
.history-card,
.script-card,
.notice-card,
.empty-state {
  border: 1px solid rgba(109, 88, 57, 0.16);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.72);
  box-shadow: 0 14px 34px rgba(66, 46, 18, 0.08);
  backdrop-filter: blur(10px);
}

.stat-card {
  padding: 14px;
}

.stat-label {
  display: block;
  margin-bottom: 8px;
  font-size: 12px;
  color: #7a6852;
}

.stat-card strong {
  font-size: 26px;
}

.meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  margin-bottom: 12px;
}

.meta-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #7a6852;
}

.meta-value {
  font-size: 12px;
  color: #3d352a;
  text-align: right;
}

.empty-state {
  padding: 18px;
  text-align: center;
  color: #5f5546;
}

.notice-card {
  padding: 13px;
  background: #fff7dc;
  color: #6c4b09;
}

.notice-title {
  margin: 0;
  font-weight: 700;
}

.hint {
  margin: 8px 0 0;
  font-size: 12px;
}

.registry-panel,
.history-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 116px;
  gap: 8px;
}

.toolbar input,
.toolbar select {
  min-width: 0;
  border: 1px solid rgba(109, 88, 57, 0.2);
  border-radius: 8px;
  padding: 9px 10px;
  background: rgba(255, 255, 255, 0.8);
  color: #1f1c17;
  font: inherit;
  font-size: 13px;
}

.registry-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.history-card {
  padding: 14px;
}

.script-card {
  padding: 13px;
}

.history-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 10px;
}

.script-id,
.script-name,
.script-summary,
.script-time,
h2,
pre {
  margin: 0;
}

.script-id {
  font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
  font-size: 13px;
  color: #8a4b14;
}

.script-time {
  margin-top: 4px;
  font-size: 12px;
  color: #7a6852;
}

.script-card-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.script-name {
  margin-bottom: 4px;
  font-size: 14px;
  font-weight: 700;
  color: #24201a;
}

.script-summary {
  margin-top: 10px;
  color: #4f463a;
  font-size: 13px;
  line-height: 1.4;
}

.pill-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-end;
}

.status-pill {
  border-radius: 999px;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  background: #ece7df;
  color: #5a4e40;
}

.status-pill[data-status='succeeded'] {
  background: #dff3df;
  color: #1c6b36;
}

.status-pill[data-status='running'] {
  background: #fff1c9;
  color: #8c5d00;
}

.status-pill[data-status='failed'] {
  background: #ffe0dc;
  color: #9c2f1f;
}

.status-pill[data-status='active'] {
  background: #dceefa;
  color: #155177;
}

.status-pill[data-status='draft'] {
  background: #eee8f9;
  color: #5a3d8b;
}

.status-pill[data-status='deprecated'] {
  background: #ebe5dd;
  color: #695844;
}

.status-pill[data-status='disabled'] {
  background: #f1e6e3;
  color: #7b4238;
}

.script-meta-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
  color: #6f604f;
  font-size: 12px;
}

.script-meta-row span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.tag-row span {
  border-radius: 999px;
  padding: 4px 7px;
  background: #f0f4e8;
  color: #4d6336;
  font-size: 11px;
  font-weight: 700;
}

.script-actions {
  display: flex;
  justify-content: flex-end;
  gap: 14px;
  margin-top: 10px;
}

.script-block {
  margin-bottom: 12px;
}

.section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.io-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.io-grid section {
  min-width: 0;
}

h2 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #7a6852;
}

.ghost-button {
  border: 0;
  padding: 0;
  background: transparent;
  color: #8a4b14;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

pre {
  overflow: auto;
  padding: 10px;
  border-radius: 8px;
  background: #201b16;
  color: #f6ecdf;
  font-size: 12px;
  line-height: 1.45;
  font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
  white-space: pre-wrap;
  word-break: break-word;
}

.preview-pre {
  max-height: calc(1.45em * 8 + 20px);
  overflow: hidden;
}

.preview-script-pre {
  max-height: calc(1.45em * 3 + 20px);
  overflow: hidden;
}

.dialog-backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(20, 14, 10, 0.56);
}

.dialog-panel {
  width: min(720px, 100%);
  max-height: min(80vh, 900px);
  padding: 14px;
  border: 1px solid rgba(109, 88, 57, 0.16);
  border-radius: 8px;
  background: #f8f2e9;
  box-shadow: 0 24px 60px rgba(20, 14, 10, 0.25);
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}

.dialog-title {
  margin: 0;
  font-size: 15px;
  line-height: 1.3;
}

.dialog-pre {
  max-height: calc(80vh - 90px);
}
</style>
