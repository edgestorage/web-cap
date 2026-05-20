import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeWebCapBuildId,
  readGeneratedWebCapBuildId,
  resolveWebCapBuildId,
  shouldPreferGeneratedBuildId,
  writeGeneratedWebCapBuildId,
} from '../lib/server/build-id';

describe('build id resolution', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const directory of tempDirs) {
      await import('node:fs/promises').then(({ rm }) =>
        rm(directory, { recursive: true, force: true }),
      );
    }
  });

  async function createFixtureProject() {
    const projectRoot = await mkdtemp(join(tmpdir(), 'web-cap-build-id-'));
    tempDirs.push(projectRoot);

    await mkdir(join(projectRoot, 'lib/server'), { recursive: true });
    await mkdir(join(projectRoot, 'shared'), { recursive: true });
    await writeFile(
      join(projectRoot, 'lib/server/example.ts'),
      'export const example = 1;\n',
      'utf8',
    );
    await writeFile(
      join(projectRoot, 'shared/example.ts'),
      'export const shared = 2;\n',
      'utf8',
    );

    return {
      projectRoot,
      generatedFilePath: join(projectRoot, '.generated/build-id.json'),
      packageJsonPath: join(projectRoot, 'package.json'),
    };
  }

  async function writeFixturePackageJson(projectRoot: string, version = '1.2.3') {
    await writeFile(
      join(projectRoot, 'package.json'),
      `${JSON.stringify({ name: 'web-capability', version }, null, 2)}\n`,
      'utf8',
    );
  }

  it('prefers an explicit environment build id override', async () => {
    const fixture = await createFixtureProject();
    const buildId = await resolveWebCapBuildId({
      ...fixture,
      env: { WEB_CAP_BUILD_ID: 'explicit-build-id' },
    });

    expect(buildId).toBe('explicit-build-id');
  });

  it('uses the generated build id outside tsx runtimes', async () => {
    const fixture = await createFixtureProject();
    const generated = await writeGeneratedWebCapBuildId(fixture);
    const buildId = await resolveWebCapBuildId({
      ...fixture,
      processArgv: ['node', 'dist/cli.js'],
      processExecArgv: [],
    });

    expect(buildId).toBe(generated);
    expect(await readGeneratedWebCapBuildId(fixture)).toBe(generated);
  });

  it('uses the package version outside tsx runtimes when package metadata is available', async () => {
    const fixture = await createFixtureProject();
    await writeFixturePackageJson(fixture.projectRoot, '0.0.3');
    await writeGeneratedWebCapBuildId(fixture);

    const buildId = await resolveWebCapBuildId({
      ...fixture,
      processArgv: ['node', 'dist/cli.js'],
      processExecArgv: [],
    });

    expect(buildId).toBe('0.0.3');
  });

  it('keeps dynamic build ids in tsx runtimes by default', async () => {
    const fixture = await createFixtureProject();
    const dynamic = await computeWebCapBuildId(fixture);
    await writeFixturePackageJson(fixture.projectRoot, '0.0.3');
    await writeGeneratedWebCapBuildId(fixture);

    const buildId = await resolveWebCapBuildId({
      ...fixture,
      processArgv: ['node', 'lib/cli.ts'],
      processExecArgv: ['/path/to/tsx/dist/preflight.cjs'],
    });

    expect(buildId).toBe(dynamic);
  });

  it('can force generated mode even in tsx runtimes', async () => {
    const fixture = await createFixtureProject();
    const generated = await writeGeneratedWebCapBuildId(fixture);

    const buildId = await resolveWebCapBuildId({
      ...fixture,
      env: { WEB_CAP_BUILD_ID_MODE: 'generated' },
      processArgv: ['node', 'lib/cli.ts'],
      processExecArgv: ['/path/to/tsx/dist/preflight.cjs'],
    });

    expect(buildId).toBe(generated);
  });

  it('detects tsx runtimes when deciding whether to prefer generated ids', () => {
    expect(
      shouldPreferGeneratedBuildId({
        processArgv: ['node', 'dist/cli.js'],
        processExecArgv: [],
      }),
    ).toBe(true);

    expect(
      shouldPreferGeneratedBuildId({
        processArgv: ['node', 'lib/cli.ts'],
        processExecArgv: ['/path/to/tsx/dist/preflight.cjs'],
      }),
    ).toBe(false);
  });
});
