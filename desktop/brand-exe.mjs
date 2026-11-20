#!/usr/bin/env node
// Brands an unpacked Windows desktop build with the husky icon, after every package-target run; the icons come from the
// brand plugin in the sibling checkout nervdog-harness-plugins:
//   <exe> icon group (taskbar button, window, Alt+Tab, Explorer) <- brand/icons/nervdog-harness.ico
//   resources/tray.ico (notification area tray, quit dialog)       <- brand/icons/nervdog-harness.ico
//   resources/icon.png (About panel)                                <- brand/icons/icon.png
// The other executable resources, including the INTEGRITY/ELECTRONASAR hash of app.asar, are written back unchanged.
// Usage: node desktop/brand-exe.mjs [win-unpacked directory]
// Default directory: <deepseek-harness>/apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked,
// with the harness at $DSH_HARNESS_DIR or the deepseek-harness submodule of this repository.
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = resolve(process.env.DSH_HARNESS_DIR || join(here, 'deepseek-harness'))
const unpacked = resolve(process.argv[2] || join(harness, 'apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked'))
const exe = join(unpacked, 'DeepSeek Harness.exe')
const iconDir = join(here, '..', 'nervdog-harness-plugins', 'brand', 'icons')
const ico = join(iconDir, 'nervdog-harness.ico')
const png = join(iconDir, 'icon.png')
for (const file of [exe, ico, png, join(unpacked, 'resources')]) {
  if (!existsSync(file)) { console.error(`error: ${file} not found`); process.exit(1) }
}
try { closeSync(openSync(exe, 'r+')) } catch {
  console.error(`error: ${exe} is in use; quit DeepSeek Harness (including its tray icon) first`)
  process.exit(1)
}

const store = join(harness, 'node_modules', '.pnpm')
const reseditDir = readdirSync(store).filter(name => /^resedit@\d/.test(name)).sort().pop()
if (reseditDir === undefined) { console.error(`error: resedit not found under ${store}; run pnpm install in the harness`); process.exit(1) }
const ResEdit = createRequire(import.meta.url)(join(store, reseditDir, 'node_modules', 'resedit'))

const executable = ResEdit.NtExecutable.from(readFileSync(exe))
const resource = ResEdit.NtExecutableResource.from(executable)
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resource.entries)
if (groups.length === 0) { console.error(`error: ${exe} has no icon group`); process.exit(1) }
const { id, lang } = groups[0]
const icons = ResEdit.Data.IconFile.from(readFileSync(ico)).icons.map(item => item.data)
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resource.entries, id, lang, icons)
resource.outputResource(executable)
const output = Buffer.from(executable.generate())

const check = ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(output))
const written = ResEdit.Resource.IconGroupEntry.fromEntries(check.entries)
if (written.length !== groups.length || written[0].icons.length !== icons.length
  || !check.entries.some(entry => entry.type === 'INTEGRITY')) {
  console.error('error: rewritten executable failed its resource check; nothing replaced')
  process.exit(1)
}
const temporary = `${exe}.branding`
writeFileSync(temporary, output)
try { renameSync(temporary, exe) } catch (error) {
  rmSync(temporary, { force: true })
  throw error
}
copyFileSync(ico, join(unpacked, 'resources', 'tray.ico'))
copyFileSync(png, join(unpacked, 'resources', 'icon.png'))
console.log(`branded ${exe}: icon group ${id} (${icons.length} sizes), resources/tray.ico, resources/icon.png`)
