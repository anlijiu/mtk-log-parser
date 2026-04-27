import { describe, expect, it } from 'vitest';
import {
  mergeAndSort,
  parseKernelLogUnified,
  parseKernelLogLine,
  parseLogLines,
  parseAndroidLogLine,
  parseMainLog,
  parseSysLog,
  type UnifiedLogEntry,
} from '../src/index';

describe('android log parsing', () => {
  it('parses main log threadtime lines', () => {
    const entries = parseMainLog(
      '----- timezone:GMT\n2026-04-14 03:13:29.947176  1284  2234 D audiocontrol-service: [VehicleControl] - onPropertyEvent',
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: 'main',
      pid: 1284,
      tid: 2234,
      priority: 'D',
      tag: 'audiocontrol-service',
      message: '[VehicleControl] - onPropertyEvent',
      timestampMicros: 1_776_136_409_947_176,
    });
    expect(entries[0].absoluteTime.toISOString()).toBe('2026-04-14T03:13:29.947Z');
  });

  it('parses a single android log line with the provided line number', () => {
    const entry = parseAndroidLogLine(
      '2026-04-14 03:13:29.947176  1284  2234 D audiocontrol-service: [VehicleControl] - onPropertyEvent',
      'main',
      {},
      42,
    );

    expect(entry).toMatchObject({
      source: 'main',
      lineNumber: 42,
      pid: 1284,
      tid: 2234,
      timestampMicros: 1_776_136_409_947_176,
    });
  });

  it('trims padded sys log tags', () => {
    const entries = parseSysLog(
      '2026-04-14 03:23:59.531915   714   787 W CanH    : get gCanMap canId(20), can_node(9) null.',
    );

    expect(entries[0]).toMatchObject({
      source: 'sys',
      priority: 'W',
      tag: 'CanH',
      message: 'get gCanMap canId(20), can_node(9) null.',
      timestampMicros: 1_776_137_039_531_915,
    });
  });
});

describe('kernel log parsing', () => {
  it('uses the UTC android time anchor to resolve relative kernel times', () => {
    const entries = parseKernelLogUnified(`----- timezone:GMT
<7>[ 1423.257212][C600000] swapper/6: [name:virtio_net&]Receiving skb proto 0x0800 len 57 type 0
<7>[ 1426.781428][T700144] wdtk-7: [name:aee_hangdet&][thread:144] 2026-04-14 03:16:25.554290 UTC;android time 2026-04-14 03:16:25.554290
<6>[ 1426.781435][T700144] wdtk-7: [name:aee_hangdet&]vm_hangdet_kick_event`);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      source: 'kernel',
      priority: 'D',
      process: 'swapper/6',
      thread: 'C600000',
      tag: 'virtio_net',
      timestampMicros: 1_776_165_382_030_074,
    });
    expect(entries[0].absoluteTime.toISOString()).toBe('2026-04-14T11:16:22.030Z');
    expect(entries[1]).toMatchObject({
      hasTimeAnchor: true,
      timestampMicros: 1_776_165_385_554_290,
    });
    expect(entries[2]).toMatchObject({
      priority: 'I',
      process: 'wdtk-7',
      tag: 'aee_hangdet',
      message: '[name:aee_hangdet&]vm_hangdet_kick_event',
      timestampMicros: 1_776_165_385_554_297,
    });
  });

  it('keeps kernel tags when messages contain later colon separators', () => {
    const entries = parseKernelLogUnified(`<7>[ 1426.781428][T700144] wdtk-7: [name:aee_hangdet&] 2026-04-14 03:16:25.554290 UTC;android time 2026-04-14 03:16:25.554290
<7>[ 1426.781429][  T787] CarPlatform: [name:virtio_net&]eth0: xmit packet`);

    expect(entries[1]).toMatchObject({
      process: 'CarPlatform',
      tag: 'virtio_net',
      message: '[name:virtio_net&]eth0: xmit packet',
    });
  });

  it('uses the last kernel time anchor in the file', () => {
    const entries = parseKernelLogUnified(`<6>[ 10.000000][T1] proc: 2026-04-14 00:00:10.000000 UTC;android time 2026-04-14 00:00:10.000000
<6>[ 19.000000][T1] proc: before last anchor
<6>[ 20.000000][T1] proc: 2026-04-14 00:01:00.000000 UTC;android time 2026-04-14 00:01:00.000000`);

    expect(entries[1].timestampMicros).toBe(1_776_153_659_000_000);
    expect(entries[1].absoluteTime.toISOString()).toBe('2026-04-14T08:00:59.000Z');
  });

  it('throws when a kernel log has no time anchor by default', () => {
    expect(() => parseKernelLogUnified('<6>[ 20.000000][T1] proc: no anchor')).toThrow(
      'Kernel log does not contain a UTC;android time anchor',
    );
  });

  it('parses a single kernel log line before resolving an anchor', () => {
    const entry = parseKernelLogLine(
      '<7>[ 1426.781428][T700144] wdtk-7: [name:aee_hangdet&] 2026-04-14 03:16:25.554290 UTC;android time 2026-04-14 03:16:25.554290',
      7,
    );

    expect(entry).toMatchObject({
      source: 'kernel',
      lineNumber: 7,
      relativeMicros: 1_426_781_428,
      anchorTimestampMicros: 1_776_165_385_554_290,
    });
  });

  it('parses kernel lines without a thread name prefix', () => {
    const entries = parseKernelLogUnified(`<6>[   17.121955][  T131] vm_hangdet_kick_event
<6>[   17.123004][  T131] [thread:131] 2026-04-22 07:33:49.617180 UTC;android time 2026-04-22 07:33:49.617180`);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      lineNumber: 1,
      thread: 'T131',
      message: 'vm_hangdet_kick_event',
      timestampMicros: 1_776_872_029_616_131,
    });
    expect(entries[1]).toMatchObject({
      lineNumber: 2,
      thread: 'T131',
      message: '[thread:131] 2026-04-22 07:33:49.617180 UTC;android time 2026-04-22 07:33:49.617180',
      timestampMicros: 1_776_872_029_617_180,
    });
    expect(entries[1].absoluteTime.toISOString()).toBe('2026-04-22T15:33:49.617Z');
  });

  it('parses empty kernel messages', () => {
    const entries = parseKernelLogUnified(`<6>[   17.123004][  T131] [thread:131] 2026-04-22 07:33:49.617180 UTC;android time 2026-04-22 07:33:49.617180
<6>[   17.123021][  T131] `);

    expect(entries[1]).toMatchObject({
      lineNumber: 2,
      message: '',
      timestampMicros: 1_776_872_029_617_197,
    });
  });

  it('parses kernel log lines from an iterable using the last anchor', async () => {
    const entries: UnifiedLogEntry[] = [];

    for await (const entry of parseLogLines(
      [
        { line: '<6>[ 10.000000][T1] proc: 2026-04-14 00:00:10.000000 UTC;android time 2026-04-14 00:00:10.000000', lineNumber: 10 },
        { line: '<6>[ 19.000000][T1] proc: before last anchor', lineNumber: 11 },
        { line: '<6>[ 20.000000][T1] proc: 2026-04-14 00:01:00.000000 UTC;android time 2026-04-14 00:01:00.000000', lineNumber: 12 },
      ],
      'kernel',
    )) {
      entries.push(entry);
    }

    expect(entries[1]).toMatchObject({
      lineNumber: 11,
      timestampMicros: 1_776_153_659_000_000,
    });
  });
});

describe('mergeAndSort', () => {
  it('sorts entries by microsecond timestamp while keeping stable ties', () => {
    const lateEntry = entry('main', 30, 1);
    const firstTieEntry = entry('kernel', 20, 2);
    const earlyEntry = entry('sys', 10, 3);
    const secondTieEntry = entry('main', 20, 4);

    expect(mergeAndSort(lateEntry, [firstTieEntry, earlyEntry], secondTieEntry)).toEqual([
      earlyEntry,
      firstTieEntry,
      secondTieEntry,
      lateEntry,
    ]);
  });
});

function entry(source: UnifiedLogEntry['source'], timestampMicros: number, lineNumber: number): UnifiedLogEntry {
  return {
    source,
    absoluteTime: new Date(timestampMicros / 1_000),
    timestampMicros,
    lineNumber,
    raw: String(lineNumber),
    priority: 'I',
    message: String(lineNumber),
  };
}
