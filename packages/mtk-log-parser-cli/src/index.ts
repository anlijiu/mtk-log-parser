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
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { cpus } from 'os';
import { type UnifiedLogEntry } from 'mtk-log-parser';

const DEFAULT_WORKERS = Math.max(1, cpus().length - 1);

export interface FileGroup {
  main: string[];
  sys: string[];
  kernel: string[];
  suffix: string;
}

type SortableEntry = {
  entry: UnifiedLogEntry;
  sequence: number;
  fileIndex: number;
};

type SerializedEntry = Omit<UnifiedLogEntry, 'absoluteTime'> & {
  absoluteTime: string;
};

type WorkerResult =
  | { success: true; runPaths: string[]; entryCount: number; fileIndex: number }
  | { success: false; error: string; fileIndex: number };

// ─── filename grouping ────────────────────────────────────────

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
      groups.set(suffix, { main: [], sys: [], kernel: [], suffix });
    }

    const group = groups.get(suffix)!;

    if (filename.includes('main_log_')) {
      group.main.push(filename);
    } else if (filename.includes('sys_log_')) {
      group.sys.push(filename);
    } else if (filename.includes('kernel_log_')) {
      group.kernel.push(filename);
    }
  }

  return groups;
}

// ─── worker pool ──────────────────────────────────────────────

function parseWorkerUrl(): URL {
  return new URL('./parse-worker.js', import.meta.url);
}

async function runWorker(
  filepath: string,
  source: 'main' | 'sys' | 'kernel',
  tempDir: string,
  fileIndex: number,
): Promise<WorkerResult> {
  return new Promise((resolveWorker, rejectWorker) => {
    const worker = new Worker(parseWorkerUrl(), {
      workerData: { filepath, source, tempDir, fileIndex },
    });

    worker.on('message', (result: WorkerResult) => {
      resolveWorker(result);
    });

    worker.on('error', rejectWorker);
    worker.on('exit', (code) => {
      if (code !== 0) {
        rejectWorker(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}

class WorkerPool {
  private activeCount = 0;
  private pending: Array<() => void> = [];

  constructor(private readonly maxWorkers: number) {}

  async submit(
    filepath: string,
    source: 'main' | 'sys' | 'kernel',
    tempDir: string,
    fileIndex: number,
  ): Promise<WorkerResult> {
    await this.acquire();

    try {
      return await runWorker(filepath, source, tempDir, fileIndex);
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.activeCount < this.maxWorkers) {
      this.activeCount += 1;
      return;
    }

    await new Promise<void>((resolvePending) => {
      this.pending.push(resolvePending);
    });
    this.activeCount += 1;
  }

  private release(): void {
    this.activeCount -= 1;
    this.pending.shift()?.();
  }
}

// ─── sort / merge ─────────────────────────────────────────────

function compareSortableEntries(leftEntry: SortableEntry, rightEntry: SortableEntry): number {
  if (leftEntry.entry.timestampMicros < rightEntry.entry.timestampMicros) {
    return -1;
  }

  if (leftEntry.entry.timestampMicros > rightEntry.entry.timestampMicros) {
    return 1;
  }

  if (leftEntry.fileIndex < rightEntry.fileIndex) {
    return -1;
  }

  if (leftEntry.fileIndex > rightEntry.fileIndex) {
    return 1;
  }

  return leftEntry.sequence - rightEntry.sequence;
}

function deserializeSortableEntry(line: string): SortableEntry {
  const parsed = JSON.parse(line) as { entry: SerializedEntry; sequence: number; fileIndex: number };

  return {
    sequence: parsed.sequence,
    fileIndex: parsed.fileIndex,
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

export async function mergeLogFiles(
  group: FileGroup,
  outputPath: string,
  tempParentDir = tmpdir(),
  maxWorkers = DEFAULT_WORKERS,
): Promise<number> {
  const tempDir = await mkdtemp(join(tempParentDir, 'mtk-log-parser-cli-'));
  const pool = new WorkerPool(maxWorkers);

  try {
    const files: Array<{ filepath: string; source: 'main' | 'sys' | 'kernel' }> = [];

    for (const filepath of group.main) {
      files.push({ filepath, source: 'main' });
    }

    for (const filepath of group.sys) {
      files.push({ filepath, source: 'sys' });
    }

    for (const filepath of group.kernel) {
      files.push({ filepath, source: 'kernel' });
    }

    const results = await Promise.all(
      files.map((file, fileIndex) =>
        pool.submit(file.filepath, file.source, tempDir, fileIndex),
      ),
    );

    const failedResult = results.find(
      (result): result is WorkerResult & { success: false } => !result.success,
    );

    if (failedResult) {
      throw new Error(`Parse failed for file index ${failedResult.fileIndex}: ${failedResult.error}`);
    }

    const successfulResults = results as Array<WorkerResult & { success: true }>;
    const allRunPaths = successfulResults.flatMap((result) => result.runPaths);
    const totalEntries = successfulResults.reduce((sum, result) => sum + result.entryCount, 0);

    if (allRunPaths.length > 0) {
      await writeMergedOutput(allRunPaths, outputPath);
    }

    return totalEntries;
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

function formatLogEntry(entry: UnifiedLogEntry): string {
  const timeStr = entry.absoluteTime.toISOString().replace('T', ' ').replace('Z', '');
  return `${timeStr} [${entry.source}] ${entry.priority} ${entry.tag ? `[${entry.tag}] ` : ''}${entry.message}`;
}

// ─── main CLI ─────────────────────────────────────────────────

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('dir', {
      alias: 'd',
      type: 'string',
      description: 'Directory containing log files',
      demandOption: true,
    })
    .option('workers', {
      alias: 'w',
      type: 'number',
      description: `Number of worker threads (default: ${DEFAULT_WORKERS})`,
      default: DEFAULT_WORKERS,
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
    const entryCount = await mergeLogFiles(group, outputPath, tmpdir(), argv.workers);

    console.log(`Created ${outputPath} with ${entryCount} entries`);
  }
}

const executedFile = process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;

if (executedFile) {
  main().catch(console.error);
}
