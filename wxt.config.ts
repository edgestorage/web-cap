import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';

const chromeExtensionKey = [
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsMHoxyXTPrdDyjpme8K9Q68np+qH8JG9WjE45anNa0j/vdoA2+IFS',
  'FIQtRUXTZ0z2cCyM7PABhJyQfC2hR097M7QO46yr3LmW+pEhnxSE1EDr3PFYixh2RNgoqj/QmqeZExUAO+X9VWjUuZuP9932xx',
  'Sfkvw13AnafmKKN67sOyBBTwUpGZGSKODThRRX8y7DvfFw56E1s+kRPmy8wAgXrSzEMIQySTj+3ogcvewhqHWI2LzqTMD2Ic',
  'v0fKMR064xfMzaTMf/nQtLN0FYBP8JJbyTuORmGzwusJWm4icUM6rXgeTPA4gUqNYs2/zKjiAF5mRnBYzUAvNSNhmYfrLxQI',
  'DAQAB',
].join('');

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
  manifest: ({ browser }) => ({
    ...(browser === 'chrome' ? { key: chromeExtensionKey } : {}),
    name: 'WEB_CAP',
    description:
      'Local-first browser automation runtime for Web Cap CLI to inspect tabs, run scripts, and observe page actions.',
    permissions: ['storage', 'tabs', 'tabGroups', 'scripting', 'debugger', 'userScripts'],
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
  })
});
