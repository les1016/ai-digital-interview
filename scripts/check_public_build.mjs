// Build an isolated source export with existing dependencies, without copying
// them, changing the live dist directory, or creating directory links.
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const [sourceWeb, exportedWeb, output] = process.argv.slice(2)
if (!sourceWeb || !exportedWeb || !output) throw new Error('Expected source web, exported web, output paths')
const require = createRequire(path.join(path.resolve(sourceWeb), 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')))
const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')))
const aliases = ['react', 'react-dom', 'lucide-react', '@mediapipe/tasks-vision'].map(name => ({
  find: name, replacement: path.join(path.resolve(sourceWeb), 'node_modules', name),
}))
await build({ root: path.resolve(exportedWeb), configFile: false,
  envDir: path.resolve(exportedWeb, '../..'), plugins: [react()],
  resolve: { alias: aliases }, build: { outDir: path.resolve(output) } })
