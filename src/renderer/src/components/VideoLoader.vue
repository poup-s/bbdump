<script setup lang="ts">
import { ref, onMounted } from 'vue';

const emit = defineEmits<{
  complete: []
}>();

const videoRef = ref<HTMLVideoElement | null>(null);
const isVisible = ref(true);
const isFading = ref(false);

const handleVideoEnd = () => {
  isFading.value = true;
  setTimeout(() => {
    isVisible.value = false;
    emit('complete');
  }, 500); // Match fade-out duration
};

const skipLoader = () => {
  if (videoRef.value) {
    videoRef.value.pause();
  }
  handleVideoEnd();
};

onMounted(() => {
  if (videoRef.value) {
    videoRef.value.play().catch(err => {
      console.error('Error playing video:', err);
      // If autoplay fails, skip loader
      handleVideoEnd();
    });
  }
});
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-500"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-500"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="isVisible"
      class="fixed inset-0 z-[1000] bg-black flex items-center justify-center"
      :class="{ 'opacity-0': isFading }"
    >
      <div class="loader-content">
        <div class="video-container">
          <video
            ref="videoRef"
            class="video-element"
            @ended="handleVideoEnd"
            muted
            playsinline
          >
            <source src="/video-intro.mp4" type="video/mp4" />
            Your browser does not support the video tag.
          </video>
        </div>
        
        <!-- Branding text -->
        <div class="branding-text">
          <h1 class="brand-name">BBDUMP</h1>
          <p class="brand-tagline">PostgreSQL Backup Manager</p>
        </div>
      </div>
      
      <!-- Skip button (optional) -->
      <button
        @click="skipLoader"
        class="absolute bottom-8 right-8 px-6 py-3 bg-white/10 hover:bg-white/20 backdrop-blur-md border border-white/20 text-white rounded-xl transition-all duration-300 hover:scale-105 z-10"
      >
        Skip
      </button>
    </div>
  </Transition>
</template>

<style scoped>
/* Ensure smooth transitions */
.transition-opacity {
  transition-property: opacity;
  transition-timing-function: ease-in-out;
}


.loader-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2rem;
}

.video-container {
  width: 80%;
  max-width: 800px;
  aspect-ratio: 16 / 9;
  border-radius: 2rem;
  overflow: hidden;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8),
              0 0 100px rgba(0, 0, 0, 0.5);
}

.video-element {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.branding-text {
  text-align: center;
  animation: fadeUp 1s ease-out 0.3s both;
}

.brand-name {
  font-size: 3.5rem;
  font-weight: 800;
  letter-spacing: 0.5rem;
  background: linear-gradient(135deg, #ffffff 0%, #a0a0a0 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  margin: 0;
  text-shadow: 0 0 40px rgba(255, 255, 255, 0.3);
}

.brand-tagline {
  font-size: 1rem;
  color: rgba(255, 255, 255, 0.6);
  margin-top: 0.5rem;
  letter-spacing: 0.2rem;
  text-transform: uppercase;
  font-weight: 300;
}

@keyframes fadeUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

</style>
