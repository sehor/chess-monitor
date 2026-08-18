import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron/simple'

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 9081,
    strictPort: true,
  },
  plugins: [
    vue(),
    electron({
      main: { entry: 'electron/main.ts' },
      preload: { input: 'electron/preload.ts' },
      renderer: {},
    }),
  ],
})
