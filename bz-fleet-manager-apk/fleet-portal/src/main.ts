import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import './assets/main.css'
import router from './router'
import { useAuthStore } from './stores/auth'
import { useThemeStore } from './stores/theme'

const app = createApp(App)

const pinia = createPinia()
app.use(pinia)
// Paint the theme before the first render so there is no light flash.
useThemeStore(pinia).init()
// A4-R12: recover the dispatcher identity for a resumed session (token
// present, identity not) before the board can render lock badges off it.
// Fire-and-forget — mounting must not wait on the network, and a failure
// here is designed to be invisible (see restoreIdentity's own comment).
void useAuthStore(pinia).restoreIdentity()
app.use(router)

app.mount('#app')
