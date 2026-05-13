import { workerData, parentPort } from 'worker_threads';
import { createWriteStream } from 'fs';
import { once } from 'events';
import { join } from 'path';
import { parseLogFileEntries, type LogSource, type UnifiedLogEntry } from 'mtk-log-parser';

const SORT_CHUNK_SIZE = 50_000;

type SortableEntry = {
  entry: UnifiedLogEntry;
  sequence: number;
  fileIndex: number;
};

type WorkerInput = {
  filepath: string;
  source: LogSource;
  tempDir: string;
  fileIndex: number;
};

function compareSortableEntries(leftEntry: SortableEntry, rightEntry: SortableEntry): number {
  if (leftEntry.entry.timestampMicros < rightEntry.entry.timestampMicros) return -1;
  if (leftEntry.entry.timestampMicros > rightEntry.entry.timestampMicros) return 1;
  return leftEntry.sequence - rightEntry.sequence;
}

function serializeSortableEntry(sortableEntry: SortableEntry): string {
  const serializedEntry = {
    ...sortableEntry.entry,
    absoluteTime: sortableEntry.entry.absoluteTime.toISOString(),
  };

  return JSON.stringify({
    entry: serializedEntry,
    sequence: sortableEntry.sequence,
    fileIndex: sortableEntry.fileIndex,
  });
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

async function createSortedRunsForFile(
  filepath: string,
  source: LogSource,
  tempDir: string,
  fileIndex: number,
): Promise<{ runPaths: string[]; entryCount: number }> {
  const runPaths: string[] = [];
  let chunk: SortableEntry[] = [];
  let sequence = 0;

  for await (const entry of parseLogFileEntries(filepath, source)) {
    chunk.push({ entry, sequence, fileIndex });
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

async function main(): Promise<void> {
  const { filepath, source, tempDir, fileIndex } = workerData as WorkerInput;

  try {
    const result = await createSortedRunsForFile(filepath, source, tempDir, fileIndex);
    parentPort!.postMessage({ success: true, ...result, fileIndex });
  } catch (error) {
    parentPort!.postMessage({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      fileIndex,
    });
  }
}

main();
