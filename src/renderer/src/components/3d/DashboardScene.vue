<script setup lang="ts">
import { computed, shallowRef, reactive } from 'vue';
import { useRafFn, useDark } from '@vueuse/core';

const isDark = useDark();
const mainGroup = shallowRef();
const techGroup = shallowRef();
const orbitsGroup = shallowRef();

// Theme adaptive colors
const emerald = '#10b981';
const metalColor = computed(() => isDark.value ? '#1e293b' : '#cbd5e1'); // Slate-800 vs Slate-300

// Data clusters setup
const count = 50;
const bits = reactive(Array.from({ length: count }, (_, i) => ({
  id: i,
  y: (Math.random() - 0.5) * 8,
  speed: 0.01 + Math.random() * 0.03,
  radius: 1.2 + Math.random() * 2.8,
  angle: Math.random() * Math.PI * 2,
  size: 0.03 + Math.random() * 0.07
})));

useRafFn(() => {
  const time = Date.now() * 0.001;
  
  if (mainGroup.value) {
    mainGroup.value.rotation.y += 0.004;
    mainGroup.value.position.y = Math.sin(time * 0.7) * 0.2;
  }
  
  if (techGroup.value) {
    techGroup.value.rotation.y -= 0.01;
    techGroup.value.rotation.z = Math.sin(time * 0.5) * 0.1;
  }

  if (orbitsGroup.value) {
    orbitsGroup.value.rotation.x += 0.005;
    orbitsGroup.value.rotation.z -= 0.008;
  }

  // Animate helical vertical data strand
  bits.forEach(b => {
    b.y += b.speed;
    if (b.y > 4) b.y = -4;
    b.angle += 0.01;
  });
});
</script>

<template>
  <TresPerspectiveCamera :position="[0, 5, 14]" :look-at="[0, 0, 0]" />
  
  <TresGroup ref="mainGroup">
    
    <!-- 1. CENTRAL COMMAND SHAFT (Energy Rod) -->
    <TresMesh :position="[0, 0, 0]">
      <TresCylinderGeometry :args="[0.15, 0.15, 7, 32]" />
      <TresMeshBasicMaterial :color="emerald" transparent :opacity="0.15" />
    </TresMesh>
    
    <!-- 2. TRIPLE SERVER MODULES (Quantum Stack) -->
    <template v-for="y in [2, 0, -2]" :key="y">
      <TresGroup :position="[0, y, 0]">
        
        <!-- Module Chassis -->
        <TresMesh>
          <TresCylinderGeometry :args="[2.2, 2.2, 0.5, 64]" />
          <TresMeshStandardMaterial 
            :color="metalColor" 
            :roughness="0.1" 
            :metalness="0.9" 
            transparent 
            :opacity="isDark ? 0.7 : 0.95"
          />
        </TresMesh>
        
        <!-- Glowing Data Interface (Internal Ring) -->
        <TresMesh :position="[0, 0, 0]">
          <TresCylinderGeometry :args="[2.23, 2.23, 0.1, 64]" />
          <TresMeshBasicMaterial :color="emerald" transparent :opacity="0.5" />
        </TresMesh>

        <!-- Mechanical Peripheral Fins (8 blocks) -->
        <template v-for="i in 8" :key="i">
          <TresMesh :rotation-y="(Math.PI * 2 / 8) * i" :position="[0, 0, 0]">
             <TresGroup :position="[2.3, 0, 0]">
                <TresBoxGeometry :args="[0.12, 0.3, 0.6]" />
                <TresMeshStandardMaterial :color="metalColor" :metalness="1" :roughness="0.05" />
             </TresGroup>
             <!-- Blinking LED detail -->
             <TresMesh :position="[2.37, 0.1, 0.2]">
               <TresBoxGeometry :args="[0.02, 0.04, 0.1]" />
               <TresMeshBasicMaterial :color="emerald" />
             </TresMesh>
          </TresMesh>
        </template>
      </TresGroup>
    </template>

    <!-- 3. SCANNER & TECH RADARS (Orbital UI) -->
    <TresGroup ref="techGroup">
      <TresMesh :rotation-x="Math.PI / 2">
        <TresTorusGeometry :args="[3.5, 0.02, 16, 128]" />
        <TresMeshBasicMaterial :color="emerald" transparent :opacity="0.4" />
      </TresMesh>
      <!-- Tech Grid Lines -->
      <TresMesh :rotation-x="Math.PI / 2">
        <TresTorusGeometry :args="[3.2, 0.005, 8, 64]" wireframe />
        <TresMeshBasicMaterial :color="emerald" transparent :opacity="0.1" />
      </TresMesh>
    </TresGroup>

    <!-- 4. FLOATING DATA ELEMENTS (Digital Dust Cluster) -->
    <template v-for="b in bits" :key="b.id">
      <TresMesh 
        :position="[
          Math.cos(b.angle) * b.radius, 
          b.y, 
          Math.sin(b.angle) * b.radius
        ]"
      >
        <TresOctahedronGeometry :args="[b.size]" />
        <TresMeshStandardMaterial :color="emerald" :emissive="emerald" :emissive-intensity="2" />
      </TresMesh>
    </template>

    <!-- 5. LARGE AMBIENT RADIUS (Depth Rings) -->
    <TresGroup ref="orbitsGroup">
      <TresMesh :rotation-x="Math.PI / 3">
        <TresTorusGeometry :args="[7, 0.01, 8, 160]" />
        <TresMeshBasicMaterial :color="emerald" transparent :opacity="0.15" />
      </TresMesh>
    </TresGroup>

  </TresGroup>

  <!-- PROFESSIONAL STUDIO LIGHTING -->
  <TresAmbientLight :intensity="isDark ? 0.3 : 1.5" />
  <TresDirectionalLight :position="[10, 20, 10]" :intensity="isDark ? 1 : 2.5" />
  <TresPointLight :position="[0, 0, 0]" :color="emerald" :intensity="isDark ? 6 : 3" :distance="20" />
</template>
