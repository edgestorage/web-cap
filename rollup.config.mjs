import alias from '@rollup/plugin-alias';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import esbuild from 'rollup-plugin-esbuild';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

const sharedPlugins = [
  alias({
    entries: [{ find: /^@shared\/(.+)$/, replacement: resolve(projectRoot, 'shared/$1.ts') }],
  }),
  nodeResolve({
    exportConditions: ['node'],
    preferBuiltins: true,
  }),
  commonjs(),
  json(),
  esbuild({
    target: 'node20',
    tsconfig: 'tsconfig.json',
  }),
];

function createCliConfig(input, file) {
  return {
    input,
    output: {
      file,
      format: 'es',
      inlineDynamicImports: true,
      sourcemap: true,
    },
    external: (id) => nodeBuiltins.has(id) || id === 'better-sqlite3',
    plugins: sharedPlugins,
  };
}

export default [
  createCliConfig('lib/cli.ts', 'dist/cli.js'),
  createCliConfig('lib/runtime-daemon.ts', 'dist/runtime-daemon.js'),
];
