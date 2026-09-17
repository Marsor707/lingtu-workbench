import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// 当前版本号只从 package.json 读取，与 Cargo.toml、tauri.conf.json 的一致性由 npm run version:check 保证。
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  plugins: [react()],
  define: { APP_VERSION: JSON.stringify(version) },
})
