import { homedir } from 'node:os';
import { join } from 'node:path';

interface StateDirEnvironment {
  APPDATA?: string;
  LOCALAPPDATA?: string;
  WEB_CAP_STATE_DIR?: string;
}

export function resolveWebCapStateDir(
  env: StateDirEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir = homedir(),
): string {
  const configured = env.WEB_CAP_STATE_DIR?.trim();
  if (configured) {
    return configured;
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) {
      return join(localAppData, 'web-cap');
    }

    const appData = env.APPDATA?.trim();
    if (appData) {
      return join(appData, 'web-cap');
    }

    return join(homeDir, 'AppData', 'Local', 'web-cap');
  }

  return join(homeDir, '.web-cap');
}
