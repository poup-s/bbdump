<script setup lang="ts">
import { TresCanvas } from '@tresjs/core';
import { Stars } from '@tresjs/cientos';
import { ref, watch } from 'vue';
import { useDark } from '@vueuse/core';

const isDark = useDark();
const sphereColor = ref(isDark.value ? '#ffffff' : '#000000');

watch(isDark, (val) => {
  sphereColor.value = val ? '#ffffff' : '#000000';
});
</script>

<template>
  <div class="fixed inset-0 -z-10 opacity-20 pointer-events-none">
    <TresCanvas clear-color="#000000" alpha>
      <TresPerspectiveCamera :position="[0, 0, 10]" />
      
      <!-- Abstract Floating Shape -->
      <TresMesh :position="[3, 0, 0]">
        <TresIcosahedronGeometry :args="[2, 0]" />
        <TresMeshBasicMaterial :color="sphereColor" wireframe />
      </TresMesh>

      <!-- Ambient Elements -->
      <Stars 
        v-if="isDark" 
        :radius="100" 
        :depth="50" 
        :count="1000" 
        :size="0.5" 
        :size-attenuation="true" 
      />
      
      <TresAmbientLight :intensity="1" />
    </TresCanvas>
  </div>
</template>
