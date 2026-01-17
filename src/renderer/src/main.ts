import { createApp } from 'vue'
import App from './App.vue'
import './style.css'

import Tres from '@tresjs/core'

const app = createApp(App)
app.use(Tres)
app.mount('#app')
