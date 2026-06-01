import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'extension',
  modules: ['@wxt-dev/module-vue'],
  vite: () => ({
    resolve: {
      alias: {
        '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      },
    },
  }),
  manifestVersion: 3,
  manifest: {
    name: 'WEB_CAP',
    description:
      'Local-first browser automation runtime for Web Cap CLI to inspect tabs, run scripts, and observe page actions.',
    permissions: ['storage', 'tabs', 'scripting', 'debugger', 'userScripts'],
    host_permissions: ['http://*/*', 'https://*/*'],
    browser_specific_settings: {
      gecko: {
        id: 'web-cap@example.com',
        data_collection_permissions: {
          required: ['none']
        },
        strict_min_version: '121.0'
      }
    }
  }
});
