import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(projectRoot, '.sidecar-build')
const serverSource = join(projectRoot, 'server', 'index.ts')
const target = process.env.TAURI_TARGET ?? execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
const extension = target.includes('windows') ? '.exe' : ''
const blobPath = join(buildDir, 'lingtu-server.blob')
const executablePath = join(buildDir, `lingtu-server${extension}`)
const targetPath = join(projectRoot, 'src-tauri', 'binaries', `lingtu-server-${target}${extension}`)
const configPath = join(buildDir, 'sea-config.json')
const bundledEntry = join(buildDir, 'index.cjs')

function runNpx(args) {
  // Windows 的 npx.cmd 需要通过 shell 启动，避免 Node 24 返回 EINVAL。
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}

mkdirSync(buildDir, { recursive: true })
mkdirSync(dirname(targetPath), { recursive: true })
if (!readFileSync(serverSource, 'utf8').includes('startServer')) {
  throw new Error(`Node 服务入口不存在: ${serverSource}`)
}

// SEA 需要单文件 CommonJS 入口；开发/测试仍使用 tsc 的类型检查产物。
runNpx([
  'esbuild', serverSource, '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundledEntry}`,
])

writeFileSync(configPath, JSON.stringify({
  main: bundledEntry,
  output: blobPath,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
}, null, 2))

execFileSync(process.execPath, ['--experimental-sea-config', configPath], { stdio: 'inherit' })
if (process.platform === 'darwin') {
  const architecture = target.startsWith('aarch64-') ? 'arm64' : 'x86_64'
  // 只有 Universal Node 才需要裁剪；CI 的 Node 通常已是单一架构，直接复制即可。
  const nodeArchitectures = execFileSync('lipo', ['-archs', process.execPath], { encoding: 'utf8' }).trim().split(/\s+/)
  if (nodeArchitectures.length > 1) {
    execFileSync('lipo', ['-thin', architecture, process.execPath, '-output', executablePath], { stdio: 'inherit' })
  } else {
    cpSync(process.execPath, executablePath, { force: true })
  }
} else {
  cpSync(process.execPath, executablePath, { force: true })
}

if (process.platform === 'darwin') {
  execFileSync('codesign', ['--remove-signature', executablePath], { stdio: 'inherit' })
}

const postjectArgs = [
  'postject', executablePath, 'NODE_SEA_BLOB', blobPath,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA')
runNpx(postjectArgs)

if (process.platform === 'darwin') {
  // 注入会移除原签名；先恢复 ad-hoc 签名，正式发布再由 CI 使用 Developer ID 重签并公证。
  execFileSync('codesign', ['--sign', '-', '--force', executablePath], { stdio: 'inherit' })
}

cpSync(executablePath, targetPath, { force: true })
rmSync(blobPath, { force: true })
rmSync(configPath, { force: true })
console.log(JSON.stringify({ sidecar: targetPath, target }))
