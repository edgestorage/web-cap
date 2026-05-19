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
    description: 'Browser extension runtime for WEB_CAP MCP web capabilities.',
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
