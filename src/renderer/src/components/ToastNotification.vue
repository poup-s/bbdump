<script setup lang="ts">
import { useToast } from '../composables/useToast';

const { toasts, removeToast } = useToast();
</script>

<template>
  <div class="fixed top-8 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-4 pointer-events-none">
    <transition-group name="toast-3d">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="pointer-events-auto group perspective-1000"
      >
        <div 
          class="relative bg-white dark:bg-zinc-900/90 backdrop-blur-xl border border-gray-200 dark:border-white/20 shadow-2xl rounded-2xl p-4 min-w-[380px] max-w-md transform-style-3d transition-all duration-500 hover:scale-105 hover:rotate-x-0"
          :class="[
            'rotate-x-12',
            toast.type === 'success' ? 'shadow-green-500/20' : '',
            toast.type === 'error' ? 'shadow-red-500/20' : '',
            toast.type === 'warning' ? 'shadow-yellow-500/20' : '',
            toast.type === 'info' ? 'shadow-blue-500/20' : ''
          ]"
        >
          <!-- 3D Depth Layer -->
          <div 
            class="absolute inset-0 rounded-2xl transform -translate-z-4 bg-black/20 blur-sm"
          ></div>

          <div class="relative flex items-center gap-4 transform translate-z-2">
            <!-- Icon Container -->
            <div 
              class="w-10 h-10 rounded-xl flex items-center justify-center shadow-inner"
              :class="[
                toast.type === 'success' ? 'bg-green-500/20 text-green-500' : '',
                toast.type === 'error' ? 'bg-red-500/20 text-red-500' : '',
                toast.type === 'warning' ? 'bg-yellow-500/20 text-yellow-500' : '',
                toast.type === 'info' ? 'bg-blue-500/20 text-blue-500' : ''
              ]"
            >
              <svg v-if="toast.type === 'success'" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
              <svg v-else-if="toast.type === 'error'" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
              <svg v-else-if="toast.type === 'warning'" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <svg v-else class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>

            <!-- Content -->
            <div class="flex-1">
              <p class="font-medium text-gray-900 dark:text-white">{{ toast.message }}</p>
            </div>

            <!-- Close Button -->
            <button
              @click="removeToast(toast.id)"
              class="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-gray-400 hover:text-foreground transition-colors"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          
          <!-- Shine Effect -->
          <div class="absolute inset-0 rounded-2xl bg-gradient-to-tr from-white/10 to-transparent pointer-events-none"></div>
        </div>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.perspective-1000 {
  perspective: 1000px;
}

.transform-style-3d {
  transform-style: preserve-3d;
}

.rotate-x-12 {
  transform: rotateX(12deg);
}

.hover\:rotate-x-0:hover {
  transform: rotateX(0deg) scale(1.05);
}

.-translate-z-4 {
  transform: translateZ(-4px);
}

.translate-z-2 {
  transform: translateZ(2px);
}

.toast-3d-enter-active,
.toast-3d-leave-active {
  transition: all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.toast-3d-enter-from {
  opacity: 0;
  transform: translateY(-100px) rotateX(-45deg) scale(0.8);
}

.toast-3d-leave-to {
  opacity: 0;
  transform: translateY(-20px) scale(0.8);
}
</style>
