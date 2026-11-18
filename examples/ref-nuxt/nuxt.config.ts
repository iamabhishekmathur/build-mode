// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  telemetry: false,
  css: ['~/assets/main.css'],
  // @stagecraft/vue ships TypeScript source.
  build: { transpile: ['@stagecraft/vue'] },
});
