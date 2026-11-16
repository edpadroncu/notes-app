import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // Relative asset paths: Electron loads the built page straight from disk.
  base: './',
  server: {
    port: Number(process.env.PORT) || 5183,
    strictPort: true,
  },
})
