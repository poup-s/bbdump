<script setup lang="ts">
import { TresCanvas } from '@tresjs/core';
import { shallowRef } from 'vue';
import { useRafFn } from '@vueuse/core';

const groupRef = shallowRef();
const ringsRef = shallowRef();

useRafFn(() => {
  if (groupRef.value) {
    groupRef.value.rotation.y += 0.02;
    // Bobbing motion
    groupRef.value.position.y = Math.sin(Date.now() * 0.002) * 0.2;
  }
  if (ringsRef.value) {
    ringsRef.value.rotation.x += 0.01;
    ringsRef.value.rotation.z -= 0.01;
  }
});
</script>

<template>
  <div class="w-full h-full rounded-xl overflow-hidden relative bg-gradient-to-br from-green-500/10 via-blue-500/10 to-purple-500/10 backdrop-blur-sm">
    <TresCanvas clear-color="transparent" alpha style="width: 100%; height: 100%;">
      <TresPerspectiveCamera :position="[0, 2, 6]" :look-at="[0, 0, 0]" />
      
      <TresGroup ref="groupRef">
        <!-- New Database Icon Construction -->
        <TresMesh :position="[0, 0, 0]">
          <TresCylinderGeometry :args="[1, 1, 2, 16]" />
          <TresMeshNormalMaterial wireframe />
        </TresMesh>
        
        <!-- Inner Glow -->
        <TresMesh :position="[0, 0, 0]">
          <TresCylinderGeometry :args="[0.8, 0.8, 1.8, 16]" />
          <TresMeshBasicMaterial color="#4ade80" :transparent="true" :opacity="0.2" />
        </TresMesh>

        <!-- Orbiting Rings indicating "New" -->
        <TresGroup ref="ringsRef">
          <TresMesh :rotation-x="Math.PI / 2">
            <TresTorusGeometry :args="[2, 0.05, 16, 100]" />
            <TresMeshBasicMaterial color="#4ade80" />
          </TresMesh>
          <TresMesh :rotation-x="Math.PI / 4">
            <TresTorusGeometry :args="[1.8, 0.05, 16, 100]" />
            <TresMeshBasicMaterial color="#4ade80" />
          </TresMesh>
        </TresGroup>
        
        <!-- Particles popping -->
        <TresMesh :position="[1.5, 1, 0]">
          <TresOctahedronGeometry :args="[0.2]" />
          <TresMeshNormalMaterial />
        </TresMesh>
        <TresMesh :position="[-1.5, -0.5, 0.5]">
          <TresOctahedronGeometry :args="[0.2]" />
          <TresMeshNormalMaterial />
        </TresMesh>
      </TresGroup>

      <TresAmbientLight :intensity="1" />
      <TresDirectionalLight :position="[5, 5, 5]" :intensity="2" />
    </TresCanvas>
    
    <div class="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
      <div class="bg-green-500/30 backdrop-blur-md px-4 py-2 rounded-full text-sm text-green-300 font-bold font-mono border-2 border-green-400/50 shadow-lg shadow-green-500/20">
        NEW DATABASE!
      </div>
    </div>
  </div>
</template>
