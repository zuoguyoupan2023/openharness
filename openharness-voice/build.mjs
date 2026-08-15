/**
 * Build openharness-voice bundles.
 *
 *  1. lib/index.js  — host half (Node ESM, esbuild bundle).
 *  2. lib/client.js — browser bundle in the DSH client-plugin format:
 *     `window.__ModuleLoader__.load({ id, factory })`. react / @deepseek-ai/*
 *     are kept external (resolved by the browser module table).
 *
 * Usage: node build.mjs
 */
import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '.')
const outDir = path.join(root, 'lib')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'))
fs.mkdirSync(outDir, { recursive: true })

const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-host-apiproxy',
]

async function buildHost() {
  const banner = `// openharness-voice — host half (Node ESM).`
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'host', 'index.ts')],
    outfile: path.join(outDir, 'index.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: EXTERNALS,
    banner: { js: banner },
    logLevel: 'info',
  })
  console.log('lib/index.js: host half (Node ESM)')
}

async function buildClient() {
  const banner = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pkg.name)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`
  const footer = `\t\treturn module.exports;\n\t}\n});`
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'client', 'index.ts')],
    outfile: path.join(outDir, 'client.js'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    sourcemap: false,
    external: EXTERNALS,
    banner: { js: banner },
    footer: { js: footer },
    logLevel: 'info',
  })
  console.log('lib/client.js: client half (browser bundle)')
}

console.log('=== building openharness-voice ===')
await buildHost()
await buildClient()
console.log('done.')
