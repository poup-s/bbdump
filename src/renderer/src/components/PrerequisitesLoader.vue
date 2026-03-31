<script setup lang="ts">
import { TresCanvas } from '@tresjs/core';
import { shallowRef } from 'vue';
import { useRafFn } from '@vueuse/core';

const databaseRef = shallowRef();
const groupRef = shallowRef();

useRafFn(() => {
  if (databaseRef.value) {
    databaseRef.value.rotation.y += 0.015;
    databaseRef.value.rotation.x = Math.sin(Date.now() * 0.001) * 0.1;
  }
  if (groupRef.value) {
    groupRef.value.rotation.y += 0.005;
  }
});
</script>

<template>
  <div class="w-full h-48 sm:h-56 rounded-xl overflow-hidden relative bg-gradient-to-br from-indigo-500/5 to-purple-600/5 border border-indigo-500/10">
    <TresCanvas clear-color="#000000" alpha>
      <TresPerspectiveCamera :position="[0, 2, 6]" :look-at="[0, 0, 0]" />
      
      <TresGroup ref="groupRef">
        <!-- Central Database -->
        <TresMesh ref="databaseRef" :position="[0, 0, 0]">
          <TresCylinderGeometry :args="[1.2, 1.2, 2.5, 16, 4, true]" />
          <TresMeshBasicMaterial color="#6366f1" wireframe :transparent="true" :opacity="0.6" />
        </TresMesh>
        
        <!-- Inner Core -->
        <TresMesh>
          <TresIcosahedronGeometry :args="[0.7, 0]" />
          <TresMeshBasicMaterial color="#818cf8" :transparent="true" :opacity="0.4" />
        </TresMesh>

        <!-- Orbiting Rings -->
        <TresMesh :rotation-x="Math.PI / 2">
          <TresTorusGeometry :args="[2.2, 0.04, 16, 100]" />
          <TresMeshBasicMaterial color="#a5b4fc" :transparent="true" :opacity="0.3" />
        </TresMesh>
        
        <TresMesh :rotation-x="Math.PI / 3" :rotation-y="Math.PI / 4">
          <TresTorusGeometry :args="[1.9, 0.04, 16, 100]" />
          <TresMeshBasicMaterial color="#c7d2fe" :transparent="true" :opacity="0.2" />
        </TresMesh>
      </TresGroup>

      <TresAmbientLight :intensity="1.2" />
      <TresDirectionalLight :position="[5, 5, 5]" :intensity="1.5" />
      <TresPointLight :position="[-5, 3, 5]" :intensity="0.8" color="#6366f1" />
    </TresCanvas>
  </div>
</template>




