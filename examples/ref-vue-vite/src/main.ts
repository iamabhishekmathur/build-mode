import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import Home from './pages/Home.vue';
import Projects from './pages/Projects.vue';
import Settings from './pages/Settings.vue';
import './styles.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: Home },
    { path: '/projects', component: Projects },
    { path: '/settings', component: Settings },
  ],
});

createApp(App).use(createPinia()).use(router).mount('#app');
