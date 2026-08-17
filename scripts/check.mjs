import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const required = [
  'package.json',
  'index.mjs',
  'cordis.patch.yml',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
  'preset/deep-performance/preset.yml',
  'preset/deep-performance/agent.cordis.yml',
  'preset/deep-performance/custom-bash.mjs',
  'preset/deep-performance/tool-bootstrap.mjs',
  'preset/deep-performance/compaction-epoch.mjs',
  'preset/deep-performance/instruction-hint.mjs',
  'preset/deep-performance/skill-search.mjs',
  'preset/deep-performance/LICENSE',
  'preset/deep-performance/NOTICE',
]

for (const path of required) await readFile(join(root, path))

const agentConfig = await readFile(join(root, 'preset/deep-performance/agent.cordis.yml'), 'utf8')
assert.match(agentConfig, /fetch:\s+false/)
assert.match(agentConfig, /thresholdRatio:\s+0\.25/)
assert.match(agentConfig, /retainRatio:\s+0\.08/)
assert.match(agentConfig, /summarizationModel:\s+deepseek-v4-flash/)
for (const match of agentConfig.matchAll(/name:\s+(\.\/[^\s]+)/g)) {
  await readFile(join(root, 'preset/deep-performance', match[1]))
}

async function files(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await files(path))
    else output.push(path)
  }
  return output
}

const forbidden = [
  /C:\\Users\\/i,
  /D:\\deepseek-harness/i,
  /\b59964\b/,
  /MetaSieve/i,
  /(?:gho|ghp|github_pat)_[A-Za-z0-9_]{12,}/,
]
for (const path of await files(root)) {
  if (/\.(?:png|jpg|ico|tgz)$/i.test(path)) continue
  if (relative(root, path).replaceAll('\\', '/') === 'scripts/check.mjs') continue
  const content = await readFile(path, 'utf8')
  for (const pattern of forbidden) {
    assert.doesNotMatch(content, pattern, `${relative(root, path)} contains forbidden local or secret material`)
  }
}

console.log('repository checks passed')
