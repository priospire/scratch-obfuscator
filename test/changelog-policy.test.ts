import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

describe('release changelog policy', () => {
  it('starts with the package version and records concise scored vulnerability notes', async () => {
    const packageMetadata = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {version: string};
    const changelog = await readFile(resolve('CHANGELOG.md'), 'utf8');
    const lines = changelog.split(/\r?\n/u);

    expect(lines[0]).toBe(`### v${packageMetadata.version}`);
    expect(changelog).toContain('\n#### Added\n');
    expect(changelog).toContain('\n#### Fixed\n');
    expect(changelog).toContain('\n#### Vulnerabilities\n');
    expect(changelog).toMatch(/\n#### Added\r?\n\r?\n- [^\r\n]+/u);
    expect(changelog).toMatch(/\n#### Fixed\r?\n\r?\n- [^\r\n]+/u);

    const entries = [...changelog.matchAll(/^##### ([^\r\n]+) - (10|[1-9])\/10\r?\n\r?\n- How: ([^\r\n]+)\r?\n- Fixed: ([^\r\n]+)$/gmu)];
    const vulnerabilityHeadings = lines.filter(line => line.startsWith('##### '));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries).toHaveLength(vulnerabilityHeadings.length);
    for (const entry of entries) {
      expect(entry[1]?.trim()).not.toBe('');
      expect(entry[3]?.trim()).not.toBe('');
      expect(entry[4]?.trim()).not.toBe('');
      expect(entry[3]?.length).toBeLessThanOrEqual(180);
      expect(entry[4]?.length).toBeLessThanOrEqual(180);
    }
  });
});
