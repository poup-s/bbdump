import { createApp } from 'vue'
import TrayPopup from './components/TrayPopup.vue'
import './tray-style.css'

const app = createApp(TrayPopup)
app.mount('#tray-app')
