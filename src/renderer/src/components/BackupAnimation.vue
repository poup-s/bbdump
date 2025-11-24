<script setup lang="ts">
import { TresCanvas } from '@tresjs/core';
import { shallowRef } from 'vue';
import { useRafFn } from '@vueuse/core';

const boxRef = shallowRef();
const groupRef = shallowRef();

useRafFn(() => {
  if (boxRef.value) {
    boxRef.value.rotation.x += 0.01;
    boxRef.value.rotation.y += 0.02;
  }
  if (groupRef.value) {
    groupRef.value.rotation.y -= 0.005;
  }
});
</script>

<template>
  <div class="w-full h-32 rounded-xl overflow-hidden relative">
    <TresCanvas clear-color="#000000" alpha>
      <TresPerspectiveCamera :position="[0, 2, 5]" :look-at="[0, 0, 0]" />
      
      <TresGroup ref="groupRef">
        <!-- Central Storage Cube -->
        <TresMesh ref="boxRef" :position="[0, 0, 0]">
          <TresBoxGeometry :args="[1.5, 1.5, 1.5]" />
          <TresMeshNormalMaterial wireframe />
        </TresMesh>
        
        <!-- Orbiting Data Particles -->
        <TresMesh :position="[2, 0, 0]">
          <TresSphereGeometry :args="[0.2, 8, 8]" />
          <TresMeshBasicMaterial color="#4ade80" />
        </TresMesh>
        <TresMesh :position="[-2, 0.5, 0]">
          <TresSphereGeometry :args="[0.2, 8, 8]" />
          <TresMeshBasicMaterial color="#4ade80" />
        </TresMesh>
        <TresMesh :position="[0, 0, 2]">
          <TresSphereGeometry :args="[0.2, 8, 8]" />
          <TresMeshBasicMaterial color="#4ade80" />
        </TresMesh>
      </TresGroup>

      <TresAmbientLight :intensity="1" />
      <TresDirectionalLight :position="[5, 5, 5]" :intensity="2" />
    </TresCanvas>
    
    <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div class="bg-black/20 backdrop-blur-[2px] px-3 py-1 rounded-full text-xs text-white font-mono animate-pulse border border-white/10">
        BACKING UP...
      </div>
    </div>
  </div>
</template>
