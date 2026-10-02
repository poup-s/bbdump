import { createApp } from 'vue'
import App from './App.vue'
import './style.css'

// No global TresJS registration: every 3D component imports TresCanvas itself and is
// loaded on demand, which keeps three.js out of the main bundle.
const app = createApp(App)
app.mount('#app')
