<script setup lang="ts">
import { TresCanvas } from '@tresjs/core';
import DashboardScene from './3d/DashboardScene.vue';
</script>

<template>
  <div class="dashboard-canvas-wrapper">
    <!-- Guaranteed transparency with alpha and clear-alpha -->
    <TresCanvas 
      alpha 
      :clear-alpha="0"
      power-preference="high-performance"
    >
      <DashboardScene />
    </TresCanvas>
  </div>
</template>

<style scoped>
.dashboard-canvas-wrapper {
  width: 100%;
  height: 100%;
  position: relative;
  background: transparent !important;
  pointer-events: none;
}

:deep(canvas) {
  background: transparent !important;
  display: block;
}
</style>
