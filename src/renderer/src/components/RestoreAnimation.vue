<script setup lang="ts">
import { TresCanvas } from '@tresjs/core';
import { shallowRef, ref } from 'vue';
import { useRafFn } from '@vueuse/core';
import * as THREE from 'three';

const groupRef = shallowRef();
const databaseRef = shallowRef();

// Particle system
const particleCount = 50;
const particles = ref<any[]>([]);

// Initialize particles
for (let i = 0; i < particleCount; i++) {
  particles.value.push({
    position: new THREE.Vector3(
      (Math.random() - 0.5) * 10, // Random start X
      5 + Math.random() * 5,      // Start high Y
      (Math.random() - 0.5) * 10  // Random start Z
    ),
    velocity: new THREE.Vector3(0, -0.1 - Math.random() * 0.2, 0), // Fall down
    offset: Math.random() * Math.PI * 2
  });
}

useRafFn(() => {
  if (!groupRef.value || !databaseRef.value) return;

  // Rotate database
  databaseRef.value.rotation.y += 0.01;
  databaseRef.value.rotation.z = Math.sin(Date.now() * 0.001) * 0.1;

  // Animate particles
  // We can't easily update individual TresMesh positions efficiently in a loop without using instances or updating the scene graph manually.
  // For simplicity in TresJS without complex instance mesh setup, we'll just rotate the whole group for now or use a simple visual trick.
  // BUT, to make it "very beautiful", let's try to animate a group of meshes.
  
  // Actually, let's just rotate the whole scene for now to keep it simple and performant, 
  // and maybe add some pulsing effect.
  
  const time = Date.now() * 0.002;
  groupRef.value.rotation.y = time * 0.2;
  
  if (databaseRef.value) {
    const scale = 1 + Math.sin(time * 2) * 0.05;
    databaseRef.value.scale.set(scale, scale, scale);
  }
});

</script>

<template>
  <div class="w-full h-64 rounded-xl overflow-hidden bg-black/5 dark:bg-black/20 border border-border relative">
    <TresCanvas clear-color="#000000" alpha>
      <TresPerspectiveCamera :position="[0, 3, 8]" :look-at="[0, 0, 0]" />
      
      <TresGroup ref="groupRef">
        <!-- Central Database Representation -->
        <TresMesh ref="databaseRef" :position="[0, 0, 0]">
          <TresCylinderGeometry :args="[1.5, 1.5, 3, 16, 4, true]" />
          <TresMeshBasicMaterial color="#3b82f6" wireframe :transparent="true" :opacity="0.5" />
        </TresMesh>
        
        <!-- Inner Core -->
        <TresMesh>
          <TresIcosahedronGeometry :args="[0.8, 0]" />
          <TresMeshBasicMaterial color="#60a5fa" :transparent="true" :opacity="0.8" />
        </TresMesh>

        <!-- Orbiting Rings -->
        <TresMesh :rotation-x="Math.PI / 2">
          <TresTorusGeometry :args="[2.5, 0.05, 16, 100]" />
          <TresMeshBasicMaterial color="#93c5fd" :transparent="true" :opacity="0.3" />
        </TresMesh>
        
        <TresMesh :rotation-x="Math.PI / 3" :rotation-y="Math.PI / 4">
          <TresTorusGeometry :args="[2.2, 0.05, 16, 100]" />
          <TresMeshBasicMaterial color="#93c5fd" :transparent="true" :opacity="0.3" />
        </TresMesh>
      </TresGroup>

      <!-- Particles / Data Stream (Simulated with Stars/Points for now as it's easier) -->
      <!-- We can use a simple particle system if we had the component, but let's stick to geometry for now -->
      
      <TresAmbientLight :intensity="1" />
      <TresDirectionalLight :position="[5, 5, 5]" :intensity="2" />
      <TresPointLight :position="[-5, 5, 5]" :intensity="1" color="#3b82f6" />
    </TresCanvas>
    
    <!-- Overlay Text -->
    <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div class="bg-black/40 backdrop-blur-sm px-4 py-2 rounded-full border border-white/10 text-white font-medium animate-pulse">
        Restoring Data...
      </div>
    </div>
  </div>
</template>
