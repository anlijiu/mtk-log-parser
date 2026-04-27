import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { groupFilesByTimestamp, mergeLogFiles } from '../src/index';

const suffix = '2026_0422_153359';
const LARGE_MERGE_TEST_TIMEOUT_MS = 30_000;

describe('mtk-log-parser-cli streaming merge', () => {
  it('groups timestamped MTK log files', () => {
    const groups = groupFilesByTimestamp([
      `/logs/main_log_${suffix}`,
      `/logs/sys_log_${suffix}`,
      `/logs/kernel_log_${suffix}.1`,
      '/logs/unrelated',
    ]);

    expect(groups.get(suffix)).toMatchObject({
      main: `/logs/main_log_${suffix}`,
      sys: `/logs/sys_log_${suffix}`,
      kernel: `/logs/kernel_log_${suffix}.1`,
    });
  });

  it('streams, globally sorts, and writes merged output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mtk-log-parser-cli-test-'));

    try {
      const main = join(dir, `main_log_${suffix}`);
      const sys = join(dir, `sys_log_${suffix}`);
      const kernel = join(dir, `kernel_log_${suffix}`);
      const output = join(dir, `merged_${suffix}`);

      await writeFile(
        main,
        [
          '2026-04-22 15:00:03.000000  1000  1000 I MainTag: main-late',
          '2026-04-22 15:00:01.000000  1000  1000 I MainTag: main-early',
        ].join('\n'),
      );
      await writeFile(sys, '2026-04-22 15:00:02.000000  2000  2000 W SysTag    : sys-middle');
      await writeFile(
        kernel,
        [
          '<6>[ 8.000000][T1] proc: [name:kern&]kernel-same-time-as-sys',
          '<6>[ 10.000000][T1] proc: 2026-04-22 15:00:04.000000 UTC;android time 2026-04-22 15:00:04.000000',
        ].join('\n'),
      );

      const entryCount = await mergeLogFiles({ suffix, main, sys, kernel }, output, dir);
      const lines = (await readFile(output, 'utf-8')).split('\n');

      expect(entryCount).toBe(5);
      expect(lines.map((line) => line.replace(/^.*\] [A-Z] (?:\[[^\]]+\] )?/, ''))).toEqual([
        'main-early',
        'sys-middle',
        'main-late',
        '[name:kern&]kernel-same-time-as-sys',
        '2026-04-22 15:00:04.000000 UTC;android time 2026-04-22 15:00:04.000000',
      ]);
      expect(lines[3]).toContain('2026-04-22 23:00:02.000 [kernel]');
      expect(lines[4]).toContain('2026-04-22 23:00:04.000 [kernel]');
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it('handles more entries than a spread-based merge can safely pass as arguments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mtk-log-parser-cli-large-test-'));
    const entryCount = 130_000;

    try {
      const main = join(dir, `main_log_${suffix}`);
      const output = join(dir, `merged_${suffix}`);
      const lines: string[] = [];

      for (let index = entryCount - 1; index >= 0; index -= 1) {
        lines.push(`${formatTimestamp(index)}  1000  1000 I LargeTag: msg-${index}`);
      }

      await writeFile(main, lines.join('\n'));

      await expect(mergeLogFiles({ suffix, main }, output, dir)).resolves.toBe(entryCount);

      const outputLines = (await readFile(output, 'utf-8')).split('\n');
      expect(outputLines).toHaveLength(entryCount);
      expect(outputLines[0]).toContain('msg-0');
      expect(outputLines[outputLines.length - 1]).toContain(`msg-${entryCount - 1}`);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }, LARGE_MERGE_TEST_TIMEOUT_MS);
});

function formatTimestamp(offsetMillis: number): string {
  const timestamp = new Date(Date.UTC(2026, 3, 22, 15, 0, 0, offsetMillis)).toISOString();

  return `${timestamp.slice(0, 10)} ${timestamp.slice(11, 19)}.${timestamp.slice(20, 23)}000`;
}
