#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { glob } from 'glob';
import { createReadStream, createWriteStream } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { createInterface } from 'readline';
import { once } from 'events';
import { tmpdir } from 'os';
import { join, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseLogFileEntries, type LogSource, type UnifiedLogEntry } from 'mtk-log-parser';

export interface FileGroup {
  main?: string;
  sys?: string;
  kernel?: string;
  suffix: string;
}

type SortableEntry = {
  entry: UnifiedLogEntry;
  sequence: number;
};
type SerializedEntry = Omit<UnifiedLogEntry, 'absoluteTime'> & {
  absoluteTime: string;
};

const SORT_CHUNK_SIZE = 50_000;

function extractTimestampSuffix(filename: string): string | null {
  const match = basename(filename).match(/_(\d{4}_\d{4}_\d{6})/);
  return match ? match[1] : null;
}

export function groupFilesByTimestamp(filenames: string[]): Map<string, FileGroup> {
  const groups = new Map<string, FileGroup>();

  for (const filename of filenames) {
    const suffix = extractTimestampSuffix(filename);
    if (!suffix) continue;

    if (!groups.has(suffix)) {
      groups.set(suffix, { suffix });
    }

    const group = groups.get(suffix)!;

    if (filename.includes('main_log_')) {
      group.main = filename;
    } else if (filename.includes('sys_log_')) {
      group.sys = filename;
    } else if (filename.includes('kernel_log_')) {
      group.kernel = filename;
    }
  }

  return groups;
}

async function* parseLogFile(filepath: string, source: LogSource): AsyncGenerator<UnifiedLogEntry> {
  yield* parseLogFileEntries(filepath, source);
}

async function* parseGroupEntries(group: FileGroup): AsyncGenerator<UnifiedLogEntry> {
  if (group.main) {
    yield* parseLogFile(group.main, 'main');
  }

  if (group.sys) {
    yield* parseLogFile(group.sys, 'sys');
  }

  if (group.kernel) {
    yield* parseLogFile(group.kernel, 'kernel');
  }
}

function compareSortableEntries(leftEntry: SortableEntry, rightEntry: SortableEntry): number {
  if (leftEntry.entry.timestampMicros < rightEntry.entry.timestampMicros) {
    return -1;
  }

  if (leftEntry.entry.timestampMicros > rightEntry.entry.timestampMicros) {
    return 1;
  }

  return leftEntry.sequence - rightEntry.sequence;
}

function serializeSortableEntry(sortableEntry: SortableEntry): string {
  const serializedEntry: SerializedEntry = {
    ...sortableEntry.entry,
    absoluteTime: sortableEntry.entry.absoluteTime.toISOString(),
  };

  return JSON.stringify({ entry: serializedEntry, sequence: sortableEntry.sequence });
}

function deserializeSortableEntry(line: string): SortableEntry {
  const parsed = JSON.parse(line) as { entry: SerializedEntry; sequence: number };

  return {
    sequence: parsed.sequence,
    entry: {
      ...parsed.entry,
      absoluteTime: new Date(parsed.entry.absoluteTime),
    },
  };
}

async function writeStreamLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  if (!stream.write(line)) {
    await once(stream, 'drain');
  }
}

async function writeSortedRun(
  entries: SortableEntry[],
  tempDir: string,
  runIndex: number,
): Promise<string> {
  entries.sort(compareSortableEntries);

  const runPath = join(tempDir, `run-${runIndex}.jsonl`);
  const stream = createWriteStream(runPath, { encoding: 'utf-8' });

  for (const entry of entries) {
    await writeStreamLine(stream, `${serializeSortableEntry(entry)}\n`);
  }

  stream.end();
  await once(stream, 'finish');

  return runPath;
}

async function createSortedRuns(group: FileGroup, tempDir: string): Promise<{ runPaths: string[]; entryCount: number }> {
  const runPaths: string[] = [];
  let chunk: SortableEntry[] = [];
  let sequence = 0;

  for await (const entry of parseGroupEntries(group)) {
    chunk.push({ entry, sequence });
    sequence += 1;

    if (chunk.length >= SORT_CHUNK_SIZE) {
      runPaths.push(await writeSortedRun(chunk, tempDir, runPaths.length));
      chunk = [];
    }
  }

  if (chunk.length > 0) {
    runPaths.push(await writeSortedRun(chunk, tempDir, runPaths.length));
  }

  return { runPaths, entryCount: sequence };
}

type RunReader = {
  next: () => Promise<SortableEntry | undefined>;
  close: () => void;
};

function createRunReader(runPath: string): RunReader {
  const lineReader = createInterface({
    input: createReadStream(runPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  const iterator = lineReader[Symbol.asyncIterator]();

  return {
    async next() {
      const result = await iterator.next();

      if (result.done) {
        return undefined;
      }

      return deserializeSortableEntry(result.value);
    },
    close() {
      lineReader.close();
    },
  };
}

class MinHeap<T> {
  private readonly values: T[] = [];

  constructor(private readonly compare: (leftValue: T, rightValue: T) => number) {}

  get size(): number {
    return this.values.length;
  }

  push(value: T): void {
    this.values.push(value);
    this.bubbleUp(this.values.length - 1);
  }

  pop(): T | undefined {
    const firstValue = this.values[0];
    const lastValue = this.values.pop();

    if (this.values.length > 0 && lastValue !== undefined) {
      this.values[0] = lastValue;
      this.bubbleDown(0);
    }

    return firstValue;
  }

  private bubbleUp(index: number): void {
    let currentIndex = index;

    while (currentIndex > 0) {
      const parentIndex = Math.floor((currentIndex - 1) / 2);

      if (this.compare(this.values[currentIndex], this.values[parentIndex]) >= 0) {
        return;
      }

      this.swap(currentIndex, parentIndex);
      currentIndex = parentIndex;
    }
  }

  private bubbleDown(index: number): void {
    let currentIndex = index;

    while (true) {
      const leftIndex = currentIndex * 2 + 1;
      const rightIndex = leftIndex + 1;
      let smallestIndex = currentIndex;

      if (
        leftIndex < this.values.length &&
        this.compare(this.values[leftIndex], this.values[smallestIndex]) < 0
      ) {
        smallestIndex = leftIndex;
      }

      if (
        rightIndex < this.values.length &&
        this.compare(this.values[rightIndex], this.values[smallestIndex]) < 0
      ) {
        smallestIndex = rightIndex;
      }

      if (smallestIndex === currentIndex) {
        return;
      }

      this.swap(currentIndex, smallestIndex);
      currentIndex = smallestIndex;
    }
  }

  private swap(leftIndex: number, rightIndex: number): void {
    [this.values[leftIndex], this.values[rightIndex]] = [
      this.values[rightIndex],
      this.values[leftIndex],
    ];
  }
}

async function writeMergedOutput(runPaths: string[], outputPath: string): Promise<void> {
  const readers = runPaths.map(createRunReader);
  const output = createWriteStream(outputPath, { encoding: 'utf-8' });
  const heap = new MinHeap<{ entry: SortableEntry; readerIndex: number }>((leftValue, rightValue) =>
    compareSortableEntries(leftValue.entry, rightValue.entry),
  );
  let wroteEntry = false;

  try {
    await Promise.all(
      readers.map(async (reader, readerIndex) => {
        const entry = await reader.next();

        if (entry) {
          heap.push({ entry, readerIndex });
        }
      }),
    );

    while (heap.size > 0) {
      const nextValue = heap.pop()!;

      await writeStreamLine(
        output,
        `${wroteEntry ? '\n' : ''}${formatLogEntry(nextValue.entry.entry)}`,
      );
      wroteEntry = true;

      const nextEntry = await readers[nextValue.readerIndex].next();

      if (nextEntry) {
        heap.push({ entry: nextEntry, readerIndex: nextValue.readerIndex });
      }
    }
  } finally {
    for (const reader of readers) {
      reader.close();
    }
  }

  output.end();
  await once(output, 'finish');
}

export async function mergeLogFiles(group: FileGroup, outputPath: string, tempParentDir = tmpdir()): Promise<number> {
  const tempDir = await mkdtemp(join(tempParentDir, 'mtk-log-parser-cli-'));

  try {
    const { runPaths, entryCount } = await createSortedRuns(group, tempDir);
    await writeMergedOutput(runPaths, outputPath);

    return entryCount;
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

function formatLogEntry(entry: UnifiedLogEntry): string {
  const timeStr = entry.absoluteTime.toISOString().replace('T', ' ').replace('Z', '');
  return `${timeStr} [${entry.source}] ${entry.priority} ${entry.tag ? `[${entry.tag}] ` : ''}${entry.message}`;
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('dir', {
      alias: 'd',
      type: 'string',
      description: 'Directory containing log files',
      demandOption: true,
    })
    .argv;

  const dir = argv.dir;

  const mainLogs = await glob('main_log_{*,*.*}', { cwd: dir, absolute: true });
  const sysLogs = await glob('sys_log_{*,*.*}', { cwd: dir, absolute: true });
  const kernelLogs = await glob('kernel_log_{*,*.*}', { cwd: dir, absolute: true });

  const allFiles = [...mainLogs, ...sysLogs, ...kernelLogs];
  const groups = groupFilesByTimestamp(allFiles);

  for (const [suffix, group] of groups) {
    const outputFilename = `merged_${suffix}`;
    const outputPath = join(dir, outputFilename);
    const entryCount = await mergeLogFiles(group, outputPath);

    console.log(`Created ${outputPath} with ${entryCount} entries`);
  }
}

const executedFile = process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;

if (executedFile) {
  main().catch(console.error);
}
