import { describe, expect, it } from 'vitest';
import { PathCapabilityBoundary, type PathBoundaryFileSystem } from '../../../src/security/index.js';

describe('PathCapabilityBoundary', () => {
  it.each([
    ['absolute POSIX path', '/etc/passwd', 'ABSOLUTE_PATH_DENIED'],
    ['parent traversal', '../secret', 'PATH_TRAVERSAL_DENIED'],
    ['UNC path', '\\\\server\\share\\secret', 'ABSOLUTE_PATH_DENIED'],
    ['Windows device path', '\\\\.\\PhysicalDrive0', 'ABSOLUTE_PATH_DENIED'],
    ['NTFS alternate data stream', 'src/file.txt:secret', 'NTFS_ADS_DENIED'],
  ])('denies %s', async (_name, candidate, code) => {
    const boundary = new PathCapabilityBoundary({
      workspaceRoot: 'C:\\repo', readRoots: ['src'], writeRoots: ['src'], platform: 'win32',
      fileSystem: windowsFileSystem(),
    });
    await expect(boundary.check('read', candidate)).resolves.toMatchObject({ allowed: false, code });
  });

  it('enforces separate read and write roots', async () => {
    const boundary = new PathCapabilityBoundary({
      workspaceRoot: '/repo', readRoots: ['src', 'docs'], writeRoots: ['src'], platform: 'posix',
      fileSystem: posixFileSystem(),
    });
    await expect(boundary.check('read', 'docs/guide.md')).resolves.toEqual({ allowed: true });
    await expect(boundary.check('write', 'docs/guide.md')).resolves.toMatchObject({ allowed: false, code: 'PATH_OUTSIDE_BOUNDARY' });
    await expect(boundary.check('write', 'src/new.ts')).resolves.toEqual({ allowed: true });
  });

  it('denies an in-workspace link whose real target escapes the boundary', async () => {
    const fileSystem = posixFileSystem(new Map([
      ['/repo/src/link/secret.txt', '/outside/secret.txt'],
    ]));
    const boundary = new PathCapabilityBoundary({
      workspaceRoot: '/repo', readRoots: ['src'], writeRoots: [], platform: 'posix', fileSystem,
    });
    await expect(boundary.check('read', 'src/link/secret.txt')).resolves.toMatchObject({
      allowed: false, code: 'PATH_OUTSIDE_BOUNDARY',
    });
  });

  it('uses case-insensitive containment on Windows without prefix confusion', async () => {
    const boundary = new PathCapabilityBoundary({
      workspaceRoot: 'C:\\Repo', readRoots: ['Src'], writeRoots: [], platform: 'win32',
      fileSystem: windowsFileSystem(),
    });
    await expect(boundary.check('read', 'src\\File.ts')).resolves.toEqual({ allowed: true });
    await expect(boundary.check('read', 'src-other\\File.ts')).resolves.toMatchObject({ allowed: false });
  });
});

function posixFileSystem(redirects: ReadonlyMap<string, string> = new Map()): PathBoundaryFileSystem {
  return {
    exists: async () => true,
    realpath: async (path) => redirects.get(path) ?? path,
  };
}

function windowsFileSystem(): PathBoundaryFileSystem {
  return {
    exists: async () => true,
    realpath: async (path) => path,
  };
}
