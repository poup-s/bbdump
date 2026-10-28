<script setup lang="ts">
/**
 * The messages of an AI conversation: the user's questions, and for each answer the tools it
 * used, the questions about what may reach the AI ("Anonymize for AI"), its text and its
 * OpenUI blocks. Shared by the database chat and the dashboard editor (whose OpenUI blocks
 * are patches of the dashboard, shown as a mark).
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import { Renderer } from '@openuidev/vue-lang';
import { useI18n } from '../../composables/useI18n';
import { ipcRenderer } from '../../electron';
import { chatLibrary, sqlDetails } from '../../chat/openuiLibrary';
import { splitOpenUi } from '../../chat/messageParts';
import { isSqlBlock, markdownLite } from '../../chat/markdownLite';
import { partialPreview } from '../../chat/maskPreview';
import type { ChatMessage, DatabaseChat, DiscloseBlock, ToolBlock } from '../../chat/chatEvents';
import { suggestionsIn, withoutSuggestions } from '../../dashboards/dashboardProgram';

const props = withDefaults(defineProps<{
  chat: DatabaseChat;
  /** The AI tool's name, for the working line */
  providerLabel: string;
  mode?: 'chat' | 'dashboard';
}>(), { mode: 'chat' });
const emit = defineEmits<{ choose: [text: string] }>();

/** A dashboard answer's text, without its suggestions (shown as buttons) */
const shownText = (text: string) => (props.mode === 'dashboard' ? withoutSuggestions(text) : text);
const suggestionsOf = (message: ChatMessage) => (message.role === 'assistant'
  ? suggestionsIn(message.blocks.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n'))
  : []);

const { t } = useI18n();
const openTools = ref(new Set<string>());

/** The mark of a dashboard patch: being written, applied, or not usable */
const dashboardMark = (message: ChatMessage, complete: boolean) => {
  const state = message.role === 'assistant' ? message.dashboard : undefined;
  if (!complete && message.role === 'assistant' && !message.done) {
    return { busy: true, icon: '', label: t('dashboards.writing'), tone: 'border-gray-200 dark:border-zinc-800 text-gray-500 dark:text-zinc-400' };
  }
  if (state === 'invalid') {
    return { busy: false, icon: 'M12 9v4m0 4h.01', label: t('dashboards.patchInvalid'), tone: 'border-amber-200 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-950/20 text-amber-700 dark:text-amber-300' };
  }
  return { busy: false, icon: 'M5 13l4 4L19 7', label: t('dashboards.patchApplied'), tone: 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/60 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-300' };
};

// Questions about what may reach the AI, asked here instead of the tray: columns to anonymize
const discloseMasks = ref(new Map<string, Set<string>>());
const maskedIn = (block: DiscloseBlock) => {
  if (!discloseMasks.value.has(block.id)) {
    // Checked at first: everything that is not known to be harmless, as in the tray
    discloseMasks.value.set(block.id, new Set(block.columns.filter(c => c.origin !== 'clear').map(c => c.name)));
  }
  return discloseMasks.value.get(block.id)!;
};
const setMasked = (block: DiscloseBlock, name: string, masked: boolean) => {
  const next = new Set(maskedIn(block));
  if (masked) next.add(name); else next.delete(name);
  discloseMasks.value = new Map(discloseMasks.value).set(block.id, next);
};
const maskAll = (block: DiscloseBlock) => {
  discloseMasks.value = new Map(discloseMasks.value).set(block.id, new Set(block.columns.map(c => c.name)));
};
const answerDisclose = async (block: DiscloseBlock, choice: 'send' | 'block') => {
  if (block.status !== 'pending') return;
  const mask = [...maskedIn(block)];
  block.status = choice === 'block' ? 'blocked' : mask.length ? 'masked' : 'sent';
  await ipcRenderer.invoke('mcp-confirm-response', { id: block.id, approved: choice !== 'block', mask: choice === 'block' ? undefined : mask });
};
/** Seconds left before bbdump's safe default applies */
const secondsLeft = (block: DiscloseBlock) => Math.min(60, Math.max(0, 60 - Math.floor((now.value - block.askedAt) / 1000)));

const toggleTool = (id: string) => {
  const next = new Set(openTools.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  openTools.value = next;
};
/** The SQL a tool ran, else its arguments, for the details */
const toolDetail = (block: ToolBlock): string => {
  const args = (block.input ?? {}) as Record<string, unknown>;
  if (typeof args.sql === 'string') return args.sql;
  const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== '');
  return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
};
const toolLabel = (block: ToolBlock) => {
  const key = `chat.tools.${block.name}`;
  const label = t(key);
  if (label !== key) return label;
  // A tool without a translation: its name made readable (get_database_size → Get database size)
  const words = block.name.replace(/_/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : t('chat.tools.unknown');
};

// Elapsed time while the AI works: something moves even between two steps
const now = ref(Date.now());
const busySince = ref(0);
let ticker: ReturnType<typeof setInterval> | undefined;
watch(() => props.chat.busy, busy => {
  clearInterval(ticker);
  if (!busy) return;
  busySince.value = Date.now();
  now.value = Date.now();
  ticker = setInterval(() => { now.value = Date.now(); }, 1000);
}, { immediate: true });
onUnmounted(() => clearInterval(ticker));
// Just before the delay ends, what is chosen in the card is sent (rather than the default)
watch(now, () => {
  for (const message of props.chat.messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.blocks) {
      if (block.type === 'disclose' && block.status === 'pending' && secondsLeft(block) <= 2) void answerDisclose(block, 'send');
    }
  }
});
const elapsed = computed(() => {
  const seconds = Math.max(0, Math.round((now.value - busySince.value) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')}`;
});
/** What the working line says: the step running now, else that the AI is thinking */
const workingLabel = (blocks: Array<{ type: string; status?: string }>) =>
  blocks.some(b => b.type === 'tool' && b.status === 'running') ? t('chat.reading') : t('chat.thinking', { tool: props.providerLabel });
</script>

<template>
  <div class="space-y-6">
    <template v-for="(message, index) in chat.messages" :key="index">
      <div v-if="message.role === 'user'" class="chat-from-right flex justify-end pl-12">
        <div class="rounded-2xl rounded-br-md bg-zinc-900 dark:bg-zinc-100 px-4 py-2.5 text-[13px] leading-relaxed text-white dark:text-zinc-900 whitespace-pre-wrap break-words">{{ message.text }}</div>
      </div>

      <div v-else class="space-y-3">
        <template v-for="(block, b) in message.blocks" :key="b">
          <!-- What may reach the AI: a result of unknown origin. Each column says what the AI will see -->
          <div v-if="block.type === 'disclose'" class="chat-rise overflow-hidden rounded-2xl border bg-white dark:bg-zinc-900" :class="block.status === 'pending' ? 'border-gray-200 dark:border-zinc-700 shadow-sm' : 'border-gray-200 dark:border-zinc-800'">
            <!-- Time left before the safe default (checked columns anonymized) -->
            <div v-if="block.status === 'pending'" class="h-0.5 bg-gray-100 dark:bg-zinc-800">
              <div class="h-full bg-emerald-500/70 transition-[width] duration-1000 ease-linear" :style="{ width: `${(secondsLeft(block) / 60) * 100}%` }" />
            </div>
            <div class="px-4 pt-3.5 pb-3 flex items-start gap-3">
              <span class="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center" :class="block.status === 'blocked' ? 'bg-gray-100 dark:bg-zinc-800 text-gray-500' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
              </span>
              <div class="flex-1 min-w-0">
                <div class="flex items-baseline gap-2">
                  <span class="flex-1 text-[13px] font-semibold text-gray-900 dark:text-zinc-100">{{ t('chat.disclose.title') }}</span>
                  <span v-if="block.status === 'pending'" class="text-[11px] tabular-nums text-gray-400 dark:text-zinc-500">{{ secondsLeft(block) }} s</span>
                </div>
                <p class="mt-0.5 text-[12px] leading-relaxed text-gray-500 dark:text-zinc-400">
                  {{ block.status === 'pending' ? t(block.engine === 'mongodb' ? 'chat.disclose.questionMongo' : 'chat.disclose.question', { rows: block.rows }) : t(block.engine === 'mongodb' && (block.status === 'masked' || block.status === 'timeout') ? `chat.disclose.doneMongo.${block.status}` : `chat.disclose.done.${block.status}`, { count: maskedIn(block).size }) }}
                </p>
              </div>
            </div>

            <template v-if="block.status === 'pending'">
              <ul class="mx-4 rounded-xl border border-gray-100 dark:border-zinc-800 divide-y divide-gray-100 dark:divide-zinc-800">
                <li v-for="c in block.columns" :key="c.name" class="px-3 py-2.5">
                  <div class="flex items-center gap-2">
                    <span class="font-mono text-[12px] font-medium text-gray-900 dark:text-zinc-100 truncate">{{ c.name }}</span>
                    <span v-if="c.origin === 'rule'" class="shrink-0 px-1.5 py-px rounded-md text-[10px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">{{ t('chat.disclose.rule') }}</span>
                    <span v-else-if="c.origin === 'unknown'" class="shrink-0 px-1.5 py-px rounded-md text-[10px] bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400">{{ t('chat.disclose.unknown') }}</span>
                    <!-- MongoDB: a field chosen in bbdump stays anonymized -->
                    <span v-if="block.engine === 'mongodb' && c.origin === 'rule'" class="ml-auto shrink-0 text-[11px] text-emerald-700 dark:text-emerald-400">{{ t('chat.disclose.always') }}</span>
                    <!-- Anonymized or as is, for this column -->
                    <span v-else class="ml-auto shrink-0 inline-flex p-0.5 rounded-lg bg-gray-100 dark:bg-zinc-800" role="radiogroup" :aria-label="c.name">
                      <button
                        type="button"
                        role="radio"
                        :aria-checked="maskedIn(block).has(c.name)"
                        class="h-6 px-2 rounded-md text-[11px] font-medium transition-colors"
                        :class="maskedIn(block).has(c.name) ? 'bg-white dark:bg-zinc-700 text-emerald-700 dark:text-emerald-400 shadow-sm' : 'text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-zinc-200'"
                        @click="setMasked(block, c.name, true)"
                      >{{ t('chat.disclose.masked') }}</button>
                      <button
                        type="button"
                        role="radio"
                        :aria-checked="!maskedIn(block).has(c.name)"
                        class="h-6 px-2 rounded-md text-[11px] font-medium transition-colors"
                        :class="!maskedIn(block).has(c.name) ? 'bg-white dark:bg-zinc-700 text-amber-700 dark:text-amber-400 shadow-sm' : 'text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-zinc-200'"
                        @click="setMasked(block, c.name, false)"
                      >{{ t('chat.disclose.asIs') }}</button>
                    </span>
                  </div>
                  <!-- What the AI will see -->
                  <div v-if="c.samples.length" class="mt-1.5 flex items-baseline gap-1.5 min-w-0 text-[11px]">
                    <span class="shrink-0 text-gray-400 dark:text-zinc-500">{{ t('chat.disclose.aiSees') }}</span>
                    <span class="font-mono truncate" :class="maskedIn(block).has(c.name) ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'">
                      {{ c.samples.map((v, i) => (maskedIn(block).has(c.name) ? (c.anonymized?.[i] ?? partialPreview(v)) : v)).join(' · ') }}
                    </span>
                  </div>
                </li>
              </ul>

              <div class="px-4 pt-3 pb-3.5 flex items-center gap-2">
                <button type="button" class="text-[11px] text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-zinc-100 underline-offset-2 hover:underline" @click="maskAll(block)">{{ t('chat.disclose.maskAll') }}</button>
                <span class="flex-1" />
                <button type="button" class="h-8 px-3 rounded-lg text-[12px] font-medium text-gray-600 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-800" @click="answerDisclose(block, 'block')">{{ t('chat.disclose.block') }}</button>
                <button
                  type="button"
                  class="chat-send group h-8 pl-3 pr-2.5 rounded-lg inline-flex items-center gap-1.5 text-[12px] font-medium text-white transition-colors"
                  :class="maskedIn(block).size ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-amber-600 hover:bg-amber-700'"
                  @click="answerDisclose(block, 'send')"
                >
                  {{ maskedIn(block).size ? t(block.engine === 'mongodb' ? 'chat.disclose.sendMaskedMongo' : 'chat.disclose.sendMasked', { count: maskedIn(block).size }) : t('chat.disclose.sendRaw') }}
                  <svg class="chat-arrow w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14m-6-6l6 6-6 6" /></svg>
                </button>
              </div>
              <p class="px-4 pb-3 -mt-1 text-[10px] text-gray-400 dark:text-zinc-500">{{ t('chat.disclose.hint') }}</p>
            </template>
          </div>

          <!-- A tool call: what the AI read -->
          <div v-else-if="block.type === 'tool'" class="chat-rise text-[12px]">
            <button type="button" class="inline-flex items-center gap-2 rounded-lg px-2 py-1 -mx-2 text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-zinc-200 hover:bg-gray-50 dark:hover:bg-zinc-800/60" @click="toggleTool(block.id)">
              <span v-if="block.status === 'running'" class="w-3.5 h-3.5 rounded-full border-2 border-emerald-500/30 border-t-emerald-500 animate-spin" />
              <svg v-else-if="block.status === 'done'" class="chat-pop w-3.5 h-3.5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
              <svg v-else class="w-3.5 h-3.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01" /></svg>
              <span>{{ toolLabel(block) }}</span>
              <span v-if="block.masked?.length" class="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400" :title="t('chat.masking.inResult', { columns: block.masked.join(', ') })">
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                <span class="max-w-[14rem] truncate">{{ t('chat.masking.short', { columns: block.masked.join(', ') }) }}</span>
              </span>
              <svg class="w-3 h-3 text-gray-300 dark:text-zinc-600 transition-transform" :class="openTools.has(block.id) ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
            </button>
            <div v-if="openTools.has(block.id)" class="mt-2 ml-5 space-y-2">
              <pre v-if="toolDetail(block)" class="rounded-lg bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 px-3 py-2 font-mono text-[11px] leading-relaxed text-gray-700 dark:text-zinc-300 whitespace-pre-wrap break-words">{{ toolDetail(block) }}</pre>
              <pre v-if="block.output" class="max-h-48 overflow-auto rounded-lg border border-gray-100 dark:border-zinc-800 px-3 py-2 font-mono text-[10px] leading-relaxed text-gray-500 dark:text-zinc-500 whitespace-pre-wrap break-words">{{ block.output }}</pre>
            </div>
          </div>

          <!-- Text, with its OpenUI blocks (tables, charts) -->
          <template v-else>
            <template v-for="(part, p) in splitOpenUi(shownText(block.text))" :key="p">
              <!-- A dashboard's answer is a patch: shown as a mark, the dashboard itself changes -->
              <div v-if="part.kind === 'ui' && mode === 'dashboard'" class="chat-rise">
                <span class="inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px]" :class="dashboardMark(message, part.complete).tone">
                  <span v-if="dashboardMark(message, part.complete).busy" class="w-3 h-3 rounded-full border-2 border-emerald-500/30 border-t-emerald-500 animate-spin" />
                  <svg v-else class="chat-pop w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" :d="dashboardMark(message, part.complete).icon" /></svg>
                  {{ dashboardMark(message, part.complete).label }}
                </span>
              </div>
              <div v-else-if="part.kind === 'ui'" class="chat-rise py-1">
                <Renderer :response="part.source" :library="chatLibrary" :is-streaming="!part.complete && !message.done" />
              </div>
              <div v-else class="chat-rise space-y-2.5 text-[13px] leading-relaxed text-gray-800 dark:text-zinc-200 break-words">
                <template v-for="(md, m) in markdownLite(part.text)" :key="m">
                  <component :is="sqlDetails(md.text)" v-if="md.type === 'code' && isSqlBlock(md)" />
                  <pre v-else-if="md.type === 'code'" class="rounded-lg bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">{{ md.text }}</pre>
                  <component :is="md.type === 'h' ? 'h4' : 'p'" v-else-if="md.type === 'p' || md.type === 'h'" :class="md.type === 'h' ? 'pt-1 font-semibold text-gray-900 dark:text-zinc-100' : ''">
                    <template v-for="(span, s) in md.inlines" :key="s"><code v-if="span.code" class="px-1 py-px rounded bg-gray-100 dark:bg-zinc-800 font-mono text-[12px]">{{ span.text }}</code><strong v-else-if="span.bold" class="font-semibold">{{ span.text }}</strong><template v-else>{{ span.text }}</template></template>
                  </component>
                  <component :is="md.type" v-else :class="md.type === 'ul' ? 'list-disc pl-5 space-y-1' : 'list-decimal pl-5 space-y-1'">
                    <li v-for="(item, i) in md.items" :key="i"><template v-for="(span, s) in item" :key="s"><code v-if="span.code" class="px-1 py-px rounded bg-gray-100 dark:bg-zinc-800 font-mono text-[12px]">{{ span.text }}</code><strong v-else-if="span.bold" class="font-semibold">{{ span.text }}</strong><template v-else>{{ span.text }}</template></template></li>
                  </component>
                </template>
              </div>
            </template>
          </template>
        </template>

        <!-- Still working: shown until the answer is complete, between steps too -->
        <div v-if="!message.done" class="chat-rise flex items-center gap-2.5 text-[12px] text-gray-500 dark:text-zinc-400" role="status" aria-live="polite">
          <!-- A small database read tier by tier, like the app's backups -->
          <span class="chat-reading w-7 h-7 rounded-lg flex items-center justify-center bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <ellipse class="chat-tier chat-tier-1" cx="12" cy="5.5" rx="7" ry="2.5" />
            <path class="chat-tier chat-tier-2" d="M5 5.5v6c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5v-6" />
            <path class="chat-tier chat-tier-3" d="M5 11.5v6c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5v-6" />
          </svg>
          </span>
          <span class="chat-shimmer font-medium">{{ workingLabel(message.blocks) }}</span>
          <span class="tabular-nums text-gray-400 dark:text-zinc-500">{{ elapsed }}</span>
        </div>
        <!-- What the AI offers next (or the choices of its question), one click away -->
        <div v-if="mode === 'dashboard' && message.done && index === chat.messages.length - 1 && suggestionsOf(message).length" class="chat-rise flex flex-wrap gap-1.5">
          <button
            v-for="s in suggestionsOf(message)"
            :key="s"
            type="button"
            class="group inline-flex items-center gap-1.5 rounded-full border border-gray-200 dark:border-zinc-700 px-3 py-1 text-[12px] text-gray-700 dark:text-zinc-300 hover:border-emerald-300 dark:hover:border-emerald-800 hover:text-emerald-700 dark:hover:text-emerald-400 transition-colors"
            @click="emit('choose', s)"
          >{{ s }}<svg class="chat-arrow w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg></button>
        </div>
        <p v-if="message.error" class="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50/60 dark:bg-red-950/20 px-4 py-3 text-[12px] leading-relaxed text-red-700 dark:text-red-300 whitespace-pre-wrap break-words">{{ message.error }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat-rise { animation: chat-rise 0.34s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.chat-from-right { animation: chat-from-right 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.chat-pop { animation: chat-pop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
@keyframes chat-rise { from { opacity: 0; transform: translateY(6px); } }
@keyframes chat-from-right { from { opacity: 0; transform: translateX(14px); } }
@keyframes chat-pop { from { opacity: 0; transform: scale(0.3); } }

/* The database icon: its tiers light up one after the other, as if read */
.chat-tier { transform-box: fill-box; transform-origin: center; }
.chat-reading .chat-tier { animation: chat-read 1.2s ease-in-out infinite; }
.chat-reading .chat-tier-2 { animation-delay: 0.15s; }
.chat-reading .chat-tier-3 { animation-delay: 0.3s; }
@keyframes chat-read {
  0%, 100% { opacity: 0.35; }
  40% { opacity: 1; transform: translateY(-0.6px); }
}

/* The working label shimmers, in the app's green */
.chat-shimmer {
  --chat-ink: rgb(107 114 128);
  background: linear-gradient(90deg, var(--chat-ink) 0%, var(--chat-ink) 40%, rgb(16 185 129) 50%, var(--chat-ink) 60%, var(--chat-ink) 100%);
  background-size: 250% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
  animation: chat-shimmer 2s linear infinite;
}
:global(.dark) .chat-shimmer { --chat-ink: rgb(161 161 170); }
@keyframes chat-shimmer { from { background-position: 100% 0; } to { background-position: -150% 0; } }

.chat-arrow { transition: transform 0.2s ease-out; }
.group:hover .chat-arrow { transform: translateX(2px); }

@media (prefers-reduced-motion: reduce) {
  .chat-rise, .chat-from-right, .chat-pop, .chat-reading .chat-tier, .chat-shimmer { animation: none !important; }
  .chat-shimmer { color: inherit; -webkit-text-fill-color: currentColor; background: none; }
}
</style>
