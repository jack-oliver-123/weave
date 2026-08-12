import { describe, expect, it } from 'vitest';
import {
  assertSupportedNodeVersion,
  CliError,
  parseCliArgs,
} from '../../../src/config/cli.js';

describe('CLI startup parsing', () => {
  it('parses config and profile overrides', () => {
    expect(parseCliArgs(['--config', 'custom.yaml', '--profile', 'chat'])).toEqual({
      action: 'run',
      configPath: 'custom.yaml',
      profileName: 'chat',
    });
  });

  it('parses workspace and explicit tool switches', () => {
    expect(parseCliArgs(['--workspace', 'repo', '--no-tools'])).toEqual({
      action: 'run', workspacePath: 'repo', toolsEnabled: false,
    });
    expect(parseCliArgs(['--tools'])).toEqual({ action: 'run', toolsEnabled: true });
  });

  it('rejects conflicting tool switches', () => {
    expect(() => parseCliArgs(['--tools', '--no-tools'])).toThrowError('互斥');
  });

  it.each([
    [['--help'], 'help'],
    [['--version'], 'version'],
  ] as const)('handles %s before starting the TUI', (args, action) => {
    expect(parseCliArgs([...args])).toEqual({ action });
  });

  it.each([['--unknown'], ['--config'], ['--profile'], ['--workspace']])('rejects invalid arguments', (args) => {
    expect(() => parseCliArgs(args)).toThrow(CliError);
  });

  it('accepts Node 22 and rejects older runtimes', () => {
    expect(() => assertSupportedNodeVersion('22.0.0')).not.toThrow();
    expect(() => assertSupportedNodeVersion('24.2.1')).not.toThrow();
    expect(() => assertSupportedNodeVersion('20.19.0')).toThrowError('Node.js 22');
  });
});
