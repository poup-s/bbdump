<script setup lang="ts">
import { useConfirm } from '../composables/useConfirm';

const { state, confirm, cancel } = useConfirm();
</script>

<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition duration-150 ease-in"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div v-if="state.show" class="fixed inset-0 z-500 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div 
        class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl max-w-md w-full border border-border overflow-hidden transform transition-all scale-100"
        @click.stop
      >
        <div class="p-6">
          <h3 class="text-xl font-bold mb-2">{{ state.title }}</h3>
          <p class="text-gray-500">{{ state.message }}</p>
        </div>
        
        <div class="bg-surface px-6 py-4 flex justify-end gap-3">
          <button
            @click="cancel"
            class="px-4 py-2 rounded-xl text-gray-600 hover:bg-white dark:hover:bg-zinc-800 transition-colors font-medium"
          >
            {{ state.cancelText }}
          </button>
          <button
            @click="confirm"
            :class="[
              'px-4 py-2 rounded-xl text-white font-medium transition-transform active:scale-95',
              state.type === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-foreground hover:bg-zinc-800'
            ]"
          >
            {{ state.confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
