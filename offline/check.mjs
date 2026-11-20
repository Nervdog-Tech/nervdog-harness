#!/usr/bin/env node
// Verifies this patch after an upstream update. Run from anywhere:
//   node offline/check.mjs
// The harness checkout is $DSH_HARNESS_DIR, else the deepseek-harness submodule
// of this repository. The temporary home patch is a copy (no symbolic link, so it
// runs on Windows without Developer Mode).
// Composes every shipped profile with offline.patch.yml as the home patch in a
// temporary DSH_HOME (the real one is never read or written), then checks:
//   1. every patch target still exists in at least one profile;
//   2. every row the patch disables is disabled in every profile that has it;
//   3. upstream config of each row the patch configures still equals upstream-config.json
//      (`--accept` records the current upstream config after you merge it into the patch);
//   4. the upstream `web` row still selects local fetch and model-route search (explicit or default);
//   5. no row of a known egress package is enabled anywhere, including preset children
//      (deepseek-account only while its origins are loopback);
//   6. runtime source contains no host missing from reviewed-hosts.json;
//   7. every known egress package still exists upstream, so a rename cannot hide it from check 5.
import { execFile } from 'node:child_process'
import { access, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(await realpath(fileURLToPath(import.meta.url)))
const wanted = resolve(process.env.DSH_HARNESS_DIR || join(here, '../deepseek-harness'))
const root = await realpath(wanted).catch(() => {
  console.error(`error: harness directory ${wanted} not found; run git submodule update --init or set DSH_HARNESS_DIR`)
  process.exit(1)
})
for (const [file, hint] of [['apps/cli/src/bin.ts', 'it is not a deepseek-harness checkout; set DSH_HARNESS_DIR'], ['node_modules/tsx', "run 'pnpm install' there first"]]) {
  if (await access(join(root, file)).then(() => false, () => true)) {
    console.error(`error: ${root} has no ${file}; ${hint}`)
    process.exit(1)
  }
}
const patchFile = join(here, 'offline.patch.yml')
const snapshotFile = join(here, 'upstream-config.json')
const accept = process.argv.includes('--accept')
const PROFILES = ['web', 'headless', 'sdk', 'sdk-minimal', 'acp']

/** Packages that contact DeepSeek or third-party services on their own. */
const EGRESS_PACKAGES = [
  '@deepseek-ai/dsh-otel',
  '@deepseek-ai/dsh-session-telemetry-otel',
  '@deepseek-ai/dsh-host-product-telemetry-otel',
  '@deepseek-ai/dsh-client-product-analytics',
  '@deepseek-ai/dsh-deepseek-account',
  '@deepseek-ai/dsh-llm-deepseek-account',
  '@deepseek-ai/dsh-client-ui-settings-account',
  '@deepseek-ai/dsh-client-ui-account-notifications',
  '@deepseek-ai/dsh-web-search-deepseek',
  '@deepseek-ai/dsh-plugin-market',
  '@deepseek-ai/dsh-experimental-translator',
  '@deepseek-ai/dsh-experimental-liveshare',
  '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice',
  '@deepseek-ai/dsh-experimental-forge-github',
  '@deepseek-ai/dsh-forge-gitlab',
  '@deepseek-ai/dsh-webhook-github',
]

/** The egress package the patch keeps mounted for the desktop boot, accepted only while every origin below is loopback. */
const LOOPBACK_ACCOUNT_PACKAGE = '@deepseek-ai/dsh-deepseek-account'
const LOOPBACK_ACCOUNT_ORIGINS = ['platformOrigin', 'harnessOrigin', 'inferenceOrigin']

/** Runtime source scanned for hosts; tests, fixtures, and Markdown are excluded. */
const SCAN_PATHSPECS = [
  'packages/*/*/src/**', 'packages/*/*/runtime/**', 'packages/*/*/*.yml', 'packages/*/*/presets/*.yml',
  'apps/*/src/**', 'apps/*/config/**', 'python/*/src/**',
  ':!**/test/**', ':!**/tests/**', ':!**/*.test.*', ':!**/*.spec.*', ':!**/fixtures/**',
  ':!**/__snapshots__/**', ':!packages/test-support/**', ':!**/*.md',
]
const HOST_PATTERN = 'https?://[A-Za-z0-9][A-Za-z0-9.-]*\\.[A-Za-z]{2,}'

const failures = []
const fail = message => failures.push(message)

/**
 * Parse every `- id:` row of a dumped entry list at any depth.
 * @param {string} text - `--dump-config` output.
 * @returns {{ id: string, depth: number, name?: string, disabled?: string, config: string }[]} rows in order.
 */
function parseRows(text) {
  const lines = text.split('\n')
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s*)- id: (\S+)\s*$/.exec(lines[i])
    if (head === null) continue
    const indent = head[1].length
    const row = { id: head[2], depth: indent, config: '' }
    let inConfig = false
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (line.trim() === '' || line.trimStart().startsWith('#')) continue
      const lineIndent = line.length - line.trimStart().length
      if (lineIndent <= indent) break
      if (lineIndent === indent + 2) {
        inConfig = false
        const field = /^\s*(name|disabled|config):\s*(.*)$/.exec(line)
        if (field?.[1] === 'name') row.name = field[2].replace(/^'(.*)'$/, '$1')
        else if (field?.[1] === 'disabled') row.disabled = field[2]
        else if (field?.[1] === 'config') { inConfig = true; row.config += field[2] }
      } else if (inConfig) row.config += `\n${line.trim()}`
    }
    rows.push(row)
  }
  return rows
}

/**
 * Compose one profile with the patch as home patch.
 * @param {string} home - temporary DSH_HOME.
 * @param {string} profile - shipped profile name.
 * @param {'--dump-config' | '--dump-default-config'} flag - full composition or bundle layers only.
 * @returns {Promise<{ stdout: string, stderr: string }>} dump output.
 */
async function dump(home, profile, flag) {
  try {
    return await run(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', profile, flag], {
      cwd: root, env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    throw new Error(`dsh --profile ${profile} ${flag} failed:\n${error.stderr ?? error.message}`)
  }
}

const patchText = await readFile(patchFile, 'utf8')
const patchRows = parseRows(patchText).filter(row => row.depth === 0)
const targets = patchRows.map(row => row.id)
const disabledTargets = patchRows.filter(row => row.disabled === 'true').map(row => row.id)
const configuredTargets = patchRows.filter(row => row.config !== '').map(row => row.id)

const recorded = JSON.parse(await readFile(snapshotFile, 'utf8').catch(() => '{}'))
const observed = {}

const home = await mkdtemp(join(tmpdir(), 'dsh-offline-check-'))
try {
  await copyFile(patchFile, join(home, 'cordis.patch.yml'))
  // Profiles share one temporary home; initialize them before composing in parallel.
  await dump(home, PROFILES[0], '--dump-default-config')
  const results = await Promise.all(PROFILES.map(async profile => ({
    profile,
    full: await dump(home, profile, '--dump-config'),
    base: await dump(home, profile, '--dump-default-config'),
  })))

  const matchedSomewhere = new Set()
  for (const { profile, full, base } of results) {
    const rows = parseRows(full.stdout)
    const top = new Map(rows.filter(row => row.depth === 0).map(row => [row.id, row]))
    const baseTop = new Map(parseRows(base.stdout).filter(row => row.depth === 0).map(row => [row.id, row]))
    const missing = new Set([...full.stderr.matchAll(/patch: entry "([^"]+)" not found/g)].map(match => match[1]))
    for (const id of targets) if (!missing.has(id) && top.has(id)) matchedSomewhere.add(id)

    for (const id of disabledTargets) {
      const row = top.get(id)
      if (row !== undefined && row.disabled !== 'true') fail(`${profile}: row "${id}" is not disabled (disabled: ${row.disabled})`)
    }
    for (const id of configuredTargets) {
      const row = baseTop.get(id)
      if (row === undefined) continue
      const key = `${profile}/${id}`
      observed[key] = row.config.trim()
      if (!accept && (recorded[key] ?? '') !== observed[key]) {
        fail(`${key}: upstream config changed; merge it into offline.patch.yml, then rerun with --accept:\n    was: ${(recorded[key] ?? '(none)').replaceAll('\n', '\n         ')}\n    now: ${(observed[key] || '(none)').replaceAll('\n', '\n         ')}`)
      }
    }
    const web = baseTop.get('web')
    const webSearch = /searchProvider: (\S+)/.exec(web?.config ?? '')?.[1]
    if (web !== undefined && !((webSearch === undefined || webSearch === 'deepseek-search-api') && /fetchProvider: http\b/.test(web.config))) {
      fail(`${profile}: upstream "web" row changed; review search/fetch providers:\n    ${web.config.replaceAll('\n', '\n    ')}`)
    }
    for (const row of rows) {
      if (row.name === LOOPBACK_ACCOUNT_PACKAGE && LOOPBACK_ACCOUNT_ORIGINS.every(key => new RegExp(`${key}: https://127\\.0\\.0\\.1:9\\b`).test(row.config))) continue
      if (row.name !== undefined && EGRESS_PACKAGES.includes(row.name) && row.disabled !== 'true') {
        fail(`${profile}: ${row.depth === 0 ? '' : 'nested '}row "${row.id}" mounts ${row.name} (disabled: ${row.disabled ?? 'absent'})`)
      }
    }
  }
  for (const id of targets) if (!matchedSomewhere.has(id)) fail(`patch target "${id}" exists in no profile; upstream renamed or removed it`)
} finally {
  await rm(home, { recursive: true, force: true })
}
if (accept) {
  await writeFile(snapshotFile, `${JSON.stringify(observed, null, 2)}\n`)
  console.log(`recorded upstream config of ${Object.keys(observed).length} rows in upstream-config.json`)
}

const reviewed = JSON.parse(await readFile(join(here, 'reviewed-hosts.json'), 'utf8'))
const known = new Set(Object.entries(reviewed).filter(([key]) => !key.startsWith('_')).flatMap(([, hosts]) => Object.keys(hosts)))
const { stdout: grepOut } = await run('git', ['grep', '-IoE', HOST_PATTERN, '--', ...SCAN_PATHSPECS], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
const unknown = new Map()
for (const line of grepOut.split('\n')) {
  const match = /^([^:]+):https?:\/\/(.+)$/.exec(line)
  if (match === null) continue
  const host = match[2].toLowerCase()
  if (known.has(host)) continue
  if (!unknown.has(host)) unknown.set(host, new Set())
  unknown.get(host).add(match[1])
}
for (const [host, files] of unknown) fail(`unreviewed host ${host} in ${[...files].slice(0, 5).join(', ')}`)

const { stdout: namesOut } = await run('git', ['grep', '-hoE', '^  "name": "@deepseek-ai/[^"]+"', '--', 'package.json', '*/package.json'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  .catch(error => (error.code === 1 ? { stdout: '' } : Promise.reject(error)))
const packageNames = new Set([...namesOut.matchAll(/"(@deepseek-ai\/[^"]+)"/g)].map(match => match[1]))
for (const name of EGRESS_PACKAGES) if (!packageNames.has(name)) fail(`egress package ${name} exists in no package.json; upstream renamed or removed it`)

if (failures.length > 0) {
  console.error(`offline check failed (${failures.length}):\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log(`offline check passed: ${PROFILES.length} profiles, ${targets.length} patch targets, ${known.size} reviewed hosts`)
