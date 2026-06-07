import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileUserScriptProvider } from '../lib/server/userscripts/file-userscript-provider';
import {
  parseUserScriptDefinition,
  validateMatchPattern,
} from '../lib/server/userscripts/userscript-parser';

const validUserScript = `/**
 * web-cap userscript
 *
 * @id com.example.foo
 * @name Foo
 * @version 1.0.0
 * @match https://example.com/*
 * @match https://docs.example.com/*
 * @runAt document-idle
 */
console.log('foo');
`;
const userScriptWithoutId = validUserScript.replace(' * @id com.example.foo\n', '');

describe('userscript provider', () => {
  let tempDir = '';

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('parses Web Cap userscript JSDoc metadata', () => {
    const definition = parseUserScriptDefinition(validUserScript, {
      installedAt: '2026-06-04T00:00:00.000Z',
      updatedAt: '2026-06-04T00:00:00.000Z',
    });

    expect(definition).toMatchObject({
      id: 'com.example.foo',
      name: 'Foo',
      version: '1.0.0',
      matches: ['https://example.com/*', 'https://docs.example.com/*'],
      runAt: 'document-idle',
      status: 'active',
    });
  });

  it('rejects userscripts without @id', () => {
    expect(() => parseUserScriptDefinition(userScriptWithoutId)).toThrow(/requires @id/);
  });

  it('parses disabled userscript status from metadata', () => {
    const definition = parseUserScriptDefinition(validUserScript.replace(
      ' * @runAt document-idle',
      ' * @runAt document-idle\n * @status disabled',
    ));

    expect(definition.status).toBe('disabled');
  });

  it('rejects userscripts without @match', () => {
    expect(() =>
      parseUserScriptDefinition(`/**
 * web-cap userscript
 *
 * @id com.example.foo
 * @name Foo
 */
console.log('foo');
`),
    ).toThrow(/@match/);
  });

  it('rejects invalid explicit userscript ids', () => {
    expect(() =>
      parseUserScriptDefinition(validUserScript.replace(
        ' * @id com.example.foo',
        ' * @id Userscript Foo',
      )),
    ).toThrow(/Invalid @id/);
    expect(() =>
      parseUserScriptDefinition(validUserScript.replace(
        ' * @id com.example.foo',
        ' * @id foo',
      )),
    ).toThrow(/Invalid @id/);
  });

  it('validates Chrome-style match patterns', () => {
    expect(() => validateMatchPattern('https://example.com/*')).not.toThrow();
    expect(() => validateMatchPattern('*://*.example.com/*')).not.toThrow();
    expect(() => validateMatchPattern('file:///*')).not.toThrow();
    expect(() => validateMatchPattern('<all_urls>')).toThrow(/not supported/);
    expect(() => validateMatchPattern('https://')).toThrow(/Invalid @match/);
    expect(() => validateMatchPattern('https://example.com:443/*')).toThrow(/port/i);
    expect(() => validateMatchPattern('https://exa*mple.com/*')).toThrow(/wildcard/);
    expect(() => validateMatchPattern('https://-example.com/*')).toThrow(/Invalid @match host/);
    expect(() => validateMatchPattern(' https://example.com/*')).toThrow(/whitespace/);
  });

  it('installs userscripts under the Web Cap userscripts state directory', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'web-cap-userscript-test-'));
    const sourceFile = join(tempDir, 'foo.js');
    await writeFile(sourceFile, validUserScript, 'utf8');

    const provider = new FileUserScriptProvider(tempDir);
    const installed = await provider.install({ filePath: sourceFile });
    const storedSource = await readFile(join(tempDir, 'userscripts', 'com.example.foo.js'), 'utf8');

    expect(installed.sourcePath).toBe(join(tempDir, 'userscripts', 'com.example.foo.js'));
    expect(storedSource).toContain('web-cap userscript');
    await expect(provider.list()).resolves.toHaveLength(1);
  });

  it('requires explicit ids for newly installed userscripts', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'web-cap-userscript-test-'));
    const sourceFile = join(tempDir, 'foo.js');
    await writeFile(sourceFile, userScriptWithoutId, 'utf8');

    const provider = new FileUserScriptProvider(tempDir);
    await expect(provider.install({ filePath: sourceFile })).rejects.toThrow(/requires @id/);
  });

  it('fails when loading old managed userscripts without @id', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'web-cap-userscript-test-'));
    const legacyFile = join(tempDir, 'userscripts', 'userscript.foo.js');
    await mkdir(join(tempDir, 'userscripts'), { recursive: true });
    await writeFile(legacyFile, userScriptWithoutId, 'utf8');

    const provider = new FileUserScriptProvider(tempDir);
    await expect(provider.list()).rejects.toThrow(/requires @id/);
  });

  it('installs userscripts under their dotted id', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'web-cap-userscript-test-'));
    const sourceFile = join(tempDir, 'foo.js');
    await writeFile(sourceFile, validUserScript, 'utf8');

    const provider = new FileUserScriptProvider(tempDir);
    const installed = await provider.install({ filePath: sourceFile });
    const storedSource = await readFile(join(tempDir, 'userscripts', 'com.example.foo.js'), 'utf8');

    expect(installed.id).toBe('com.example.foo');
    expect(installed.sourcePath).toBe(join(tempDir, 'userscripts', 'com.example.foo.js'));
    expect(storedSource).toContain('@id com.example.foo');
  });

  it('installs userscripts from source content', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'web-cap-userscript-test-'));

    const provider = new FileUserScriptProvider(tempDir);
    const installed = await provider.install({
      source: validUserScript,
      sourcePath: '<stdin>',
    });
    const storedSource = await readFile(join(tempDir, 'userscripts', 'com.example.foo.js'), 'utf8');

    expect(installed.sourcePath).toBe(join(tempDir, 'userscripts', 'com.example.foo.js'));
    expect(storedSource).toContain('web-cap userscript');
    await expect(provider.list()).resolves.toHaveLength(1);
  });

  it('removes installed userscripts by id', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'web-cap-userscript-test-'));
    const sourceFile = join(tempDir, 'foo.js');
    await writeFile(sourceFile, validUserScript, 'utf8');

    const provider = new FileUserScriptProvider(tempDir);
    await provider.install({ filePath: sourceFile });
    const removed = await provider.remove('com.example.foo');

    expect(removed.id).toBe('com.example.foo');
    await expect(provider.list()).resolves.toHaveLength(0);
  });

  it('persists userscript status changes in the script metadata', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'web-cap-userscript-test-'));
    const sourceFile = join(tempDir, 'foo.js');
    await writeFile(sourceFile, validUserScript, 'utf8');

    const provider = new FileUserScriptProvider(tempDir);
    await provider.install({ filePath: sourceFile });
    const disabled = await provider.setStatus('com.example.foo', 'disabled');
    const storedSource = await readFile(join(tempDir, 'userscripts', 'com.example.foo.js'), 'utf8');

    expect(disabled.status).toBe('disabled');
    expect(storedSource).toContain('@status disabled');
    await expect(provider.list()).resolves.toMatchObject([{ status: 'disabled' }]);

    const enabled = await provider.setStatus('com.example.foo', 'active');
    expect(enabled.status).toBe('active');
    await expect(provider.list()).resolves.toMatchObject([{ status: 'active' }]);
  });
});
