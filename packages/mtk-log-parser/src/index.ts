import { parse as parseAst, registerDynamicLanguage, type SgNode } from '@ast-grep/napi';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

export type LogSource = 'main' | 'sys' | 'kernel';

export type MissingKernelAnchorMode = 'throw' | 'relative' | 'skip';

export type ParseOptions = {
  defaultYear?: number;
};

export type KernelParseOptions = ParseOptions & {
  missingAnchor?: MissingKernelAnchorMode;
};

export type UnifiedLogEntry = {
  source: LogSource;
  absoluteTime: Date;
  timestampMicros: number;
  lineNumber: number;
  raw: string;
  priority: string;
  message: string;
  tag?: string;
  pid?: number;
  tid?: number;
  process?: string;
  thread?: string;
  kernelLevel?: number;
  relativeSeconds?: number;
  hasTimeAnchor?: boolean;
};

export type ParsedKernelLine = Omit<UnifiedLogEntry, 'absoluteTime' | 'timestampMicros' | 'hasTimeAnchor'> & {
  relativeMicros: number;
  anchorTimestampMicros?: number;
};

export type LogLineInput = string | {
  line: string;
  lineNumber?: number;
};

type TreeSitterGrammar = {
  packageName: string;
  libraryFile: string;
  languageName: string;
  languageSymbol: string;
};

const MICROSECONDS_PER_MILLISECOND = 1_000;
const MICROSECONDS_PER_SECOND = 1_000_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const KERNEL_LOG_TIME_OFFSET_HOURS = 8;
const KERNEL_LOG_TIME_OFFSET_MICROS =
  KERNEL_LOG_TIME_OFFSET_HOURS * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MICROSECONDS_PER_SECOND;
const FIRST_CAPTURE_GROUP = 1;
const SECOND_CAPTURE_GROUP = 2;
const THIRD_CAPTURE_GROUP = 3;
const FOURTH_CAPTURE_GROUP = 4;
const FIFTH_CAPTURE_GROUP = 5;
const SIXTH_CAPTURE_GROUP = 6;
const YEAR_CAPTURE_GROUP = 1;
const MONTH_CAPTURE_GROUP = 2;
const DAY_CAPTURE_GROUP = 3;
const HOUR_CAPTURE_GROUP = 1;
const MINUTE_CAPTURE_GROUP = 2;
const SECOND_CAPTURE_GROUP_IN_TIME = 3;
const FRACTION_CAPTURE_GROUP = 4;
const MAX_FRACTION_DIGITS = 6;
const EMPTY_FRACTION = '';
const FRACTION_PAD = '0';
const SORT_BEFORE = -1;
const SORT_AFTER = 1;
const DEFAULT_MISSING_ANCHOR_MODE: MissingKernelAnchorMode = 'throw';
const ANDROID_AST_LANGUAGE = 'androidlog';
const KERNEL_AST_LANGUAGE = 'klog';
const FIRST_LINE_NUMBER = 1;
const ANDROID_FILE_PARSE_CHUNK_SIZE = 5_000;

const androidGrammar: TreeSitterGrammar = {
  packageName: 'mtk-android-log-parser',
  libraryFile: 'libtree-sitter-androidlog.so',
  languageName: ANDROID_AST_LANGUAGE,
  languageSymbol: 'tree_sitter_androidlog',
};

const kernelGrammar: TreeSitterGrammar = {
  packageName: 'mtk-kernel-log-parser',
  libraryFile: 'libtree-sitter-kernellog.so',
  languageName: KERNEL_AST_LANGUAGE,
  languageSymbol: 'tree_sitter_klog',
};

const requireFromHere = createRequire(import.meta.url);
const datePattern = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/;
const timePattern = /^(\d{2}):(\d{2}):(\d{2})[.,](\d{1,6})$/;
const fallbackKernelLinePattern = /^<(\d+)>\[\s*(\d+\.\d+)\]\[([^\]]+)\]\s*(.*)$/;
const kernelAnchorPattern = /UTC;android time\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}[.,]\d{1,6})/;
const kernelTagPattern = /^\[name:([^&\]]+)&\]/;

let languagesRegistered = false;

export function parseMainLog(content: string, options: ParseOptions = {}): UnifiedLogEntry[] {
  return parseAndroidLog(content, 'main', options);
}

export function parseSysLog(content: string, options: ParseOptions = {}): UnifiedLogEntry[] {
  return parseAndroidLog(content, 'sys', options);
}

export function parseAndroidLog(
  content: string,
  source: Exclude<LogSource, 'kernel'>,
  options: ParseOptions = {},
): UnifiedLogEntry[] {
  return parseAndroidLogContent(content, source, options);
}

function parseAndroidLogContent(
  content: string,
  source: Exclude<LogSource, 'kernel'>,
  options: ParseOptions = {},
  lineNumberOffset = 0,
): UnifiedLogEntry[] {
  const parseContent = normalizeParseContent(content);
  const root = parseWithAstGrep(parseContent, ANDROID_AST_LANGUAGE).root();
  const logNodes = findNodes(root, ['log_line', 'ide_log_line']);
  return logNodes.map((logNode) => parseAndroidTreeLine(logNode, source, options, lineNumberOffset));
}

export function parseKernelLogUnified(
  content: string,
  options: KernelParseOptions = {},
): UnifiedLogEntry[] {
  const parseContent = normalizeParseContent(content);
  const root = parseWithAstGrep(parseContent, KERNEL_AST_LANGUAGE).root();
  const lineNodes = findKernelLineNodes(root);
  const parsedLines = includeFallbackKernelLines(
    lineNodes.map(parseKernelTreeLine),
    content,
  );
  return resolveKernelLogLines(parsedLines, options);
}

export function mergeAndSort(
  ...entryGroups: Array<UnifiedLogEntry | readonly UnifiedLogEntry[]>
): UnifiedLogEntry[] {
  const entries = entryGroups.flatMap((entryGroup) =>
    Array.isArray(entryGroup) ? [...entryGroup] : [entryGroup],
  );

  return entries
    .map((entry, originalIndex) => ({ entry, originalIndex }))
    .sort((leftEntry, rightEntry) => {
      if (leftEntry.entry.timestampMicros < rightEntry.entry.timestampMicros) {
        return SORT_BEFORE;
      }

      if (leftEntry.entry.timestampMicros > rightEntry.entry.timestampMicros) {
        return SORT_AFTER;
      }

      return leftEntry.originalIndex - rightEntry.originalIndex;
    })
    .map(({ entry }) => entry);
}

export function parseLogContent(
  content: string,
  source: LogSource,
  options: KernelParseOptions = {},
): UnifiedLogEntry[] {
  switch (source) {
    case 'main':
      return parseMainLog(content, options);
    case 'sys':
      return parseSysLog(content, options);
    case 'kernel':
      return parseKernelLogUnified(content, options);
  }
}

export function parseAndroidLogLine(
  line: string,
  source: Exclude<LogSource, 'kernel'>,
  options: ParseOptions = {},
  lineNumber = FIRST_LINE_NUMBER,
): UnifiedLogEntry | undefined {
  const parseContent = normalizeParseContent(line);
  const root = parseWithAstGrep(parseContent, ANDROID_AST_LANGUAGE).root();
  const logNode = findNodes(root, ['log_line', 'ide_log_line'])[0];

  return logNode ? parseAndroidTreeLine(logNode, source, options, lineNumber - FIRST_LINE_NUMBER) : undefined;
}

export function parseKernelLogLine(
  line: string,
  lineNumber = FIRST_LINE_NUMBER,
): ParsedKernelLine | undefined {
  const parseContent = normalizeParseContent(line);
  const root = parseWithAstGrep(parseContent, KERNEL_AST_LANGUAGE).root();
  const lineNode = findKernelLineNodes(root)[0];

  return lineNode
    ? parseKernelTreeLine(lineNode, lineNumber - FIRST_LINE_NUMBER)
    : parseFallbackKernelLine(line, lineNumber);
}

export async function* parseLogLines(
  lines: AsyncIterable<LogLineInput> | Iterable<LogLineInput>,
  source: LogSource,
  options: KernelParseOptions = {},
): AsyncGenerator<UnifiedLogEntry> {
  if (source === 'kernel') {
    const parsedLines: ParsedKernelLine[] = [];

    for await (const { line, lineNumber } of enumerateLogLines(lines)) {
      const entry = parseKernelLogLine(line, lineNumber);

      if (entry) {
        parsedLines.push(entry);
      }
    }

    yield* resolveKernelLogLines(parsedLines, options);
    return;
  }

  for await (const { line, lineNumber } of enumerateLogLines(lines)) {
    const entry = parseAndroidLogLine(line, source, options, lineNumber);

    if (entry) {
      yield entry;
    }
  }
}

export async function* parseLogFileEntries(
  filepath: string,
  source: LogSource,
  options: KernelParseOptions = {},
): AsyncGenerator<UnifiedLogEntry> {
  if (source === 'kernel') {
    yield* parseKernelLogUnified(await readFile(filepath, 'utf-8'), options);
    return;
  }

  yield* parseAndroidLogFileEntries(filepath, source, options);
}

function parseAndroidTreeLine(
  logNode: SgNode,
  source: Exclude<LogSource, 'kernel'>,
  options: ParseOptions,
  lineNumberOffset = 0,
): UnifiedLogEntry {
  const date = textForRequiredChild(logNode, 'date');
  const time = textForRequiredChild(logNode, 'time');
  const timestampMicros = parseTimestampMicros(date, time, options);
  const priority = textForRequiredChild(logNode, 'priority').trim();
  const tag = removeTrailingColon(textForRequiredChild(logNode, 'tag').trim());
  const message = textForRequiredChild(logNode, 'message');
  const baseEntry = {
    source,
    absoluteTime: dateFromMicros(timestampMicros),
    timestampMicros,
    lineNumber: logNode.range().start.line + 1 + lineNumberOffset,
    raw: logNode.text(),
    priority,
    tag,
    message,
  };

  if (logNode.kind() === 'ide_log_line') {
    return {
      ...baseEntry,
      thread: removeBrackets(textForRequiredChild(logNode, 'thread_name')),
    };
  }

  return {
    ...baseEntry,
    pid: Number(textForRequiredChild(logNode, 'pid')),
    tid: Number(textForRequiredChild(logNode, 'tid')),
  };
}

function parseKernelTreeLine(lineNode: SgNode, lineNumberOffset = 0): ParsedKernelLine {
  const priority = Number(textForRequiredChild(lineNode, 'priority'));
  const relativeTime = textForRequiredChild(lineNode, 'rel_time').trim();
  const message = buildKernelMessage(lineNode);
  const anchorMatch = message.match(kernelAnchorPattern);
  const process = kernelProcess(lineNode);

  return {
    source: 'kernel',
    lineNumber: lineNode.range().start.line + 1 + lineNumberOffset,
    raw: lineNode.text().replace(/\r?\n$/, EMPTY_FRACTION),
    priority: kernelPriority(priority),
    message,
    ...(process ? { process } : {}),
    thread: textForRequiredChild(lineNode, 'cpu_info').trim(),
    tag: extractKernelTag(message),
    kernelLevel: priority,
    relativeSeconds: Number(relativeTime),
    relativeMicros: secondsToMicros(relativeTime),
    anchorTimestampMicros: anchorMatch
      ? parseTimestampMicros(anchorMatch[FIRST_CAPTURE_GROUP], anchorMatch[SECOND_CAPTURE_GROUP]) +
        KERNEL_LOG_TIME_OFFSET_MICROS
      : undefined,
  };
}

function buildKernelMessage(lineNode: SgNode): string {
  const taggedInfo = textForChild(lineNode, 'tagged_info') ?? EMPTY_FRACTION;
  const message = textForChild(lineNode, 'message');

  if (message !== undefined) {
    return `${taggedInfo}${message}`;
  }

  return buildKernelAnchorMessage(lineNode);
}

function buildKernelAnchorMessage(lineNode: SgNode): string {
  const taggedInfo = textForChild(lineNode, 'tagged_info') ?? EMPTY_FRACTION;
  const timestamps = childrenOfType(lineNode, 'android_timestamp').map((timestampNode) => timestampNode.text());

  if (timestamps.length >= SECOND_CAPTURE_GROUP) {
    return `${taggedInfo}${timestamps[0]} UTC;android time ${timestamps[1]}`;
  }

  return taggedInfo;
}

function kernelProcess(lineNode: SgNode): string | undefined {
  const threadPrefix = textForChild(lineNode, 'thread_prefix');

  if (threadPrefix !== undefined) {
    return removeTrailingColon(threadPrefix);
  }

  return textForChild(lineNode, 'thread_name')?.trim();
}

function parseWithAstGrep(content: string, language: string) {
  ensureParserLanguagesRegistered();

  return parseAst(language, content);
}

function ensureParserLanguagesRegistered(): void {
  if (languagesRegistered) {
    return;
  }

  languagesRegistered = true;
  registerDynamicLanguage({
    [androidGrammar.languageName]: {
      libraryPath: resolveGrammarLibrary(androidGrammar),
      extensions: ['curf'],
      languageSymbol: androidGrammar.languageSymbol,
    },
    [kernelGrammar.languageName]: {
      libraryPath: resolveGrammarLibrary(kernelGrammar),
      extensions: ['curf'],
      languageSymbol: kernelGrammar.languageSymbol,
    },
  });
}

function resolveGrammarLibrary(grammar: TreeSitterGrammar): string {
  const packageJsonPath = requireFromHere.resolve(`${grammar.packageName}/package.json`);

  return join(dirname(packageJsonPath), grammar.libraryFile);
}

function findNodes(root: SgNode, types: readonly string[]): SgNode[] {
  const foundNodes: SgNode[] = [];

  visitNodes(root, (node) => {
    if (types.includes(String(node.kind()))) {
      foundNodes.push(node);
      return false;
    }

    return true;
  });

  return foundNodes;
}

function findKernelLineNodes(root: SgNode): SgNode[] {
  return findNodes(root, ['regular_line', 'time_anchor_line', 'message_line']);
}

function visitNodes(node: SgNode, visitor: (node: SgNode) => boolean): void {
  if (!visitor(node)) {
    return;
  }

  for (const child of node.children()) {
    visitNodes(child, visitor);
  }
}

function textForRequiredChild(node: SgNode, childType: string): string {
  const text = textForChild(node, childType);

  if (text === undefined) {
    throw new Error(`Expected ${node.kind()} to contain ${childType}`);
  }

  return text;
}

function textForChild(node: SgNode, childType: string): string | undefined {
  return childrenOfType(node, childType)[0]?.text();
}

function childrenOfType(node: SgNode, childType: string): SgNode[] {
  return node.children().filter((child) => child.kind() === childType);
}

function includeFallbackKernelLines(
  parsedLines: readonly ParsedKernelLine[],
  content: string,
): ParsedKernelLine[] {
  const lineNumbersByRawLine = new Map<string, number[]>();

  for (const [lineIndex, line] of content.split(/\r?\n/).entries()) {
    if (line.startsWith('<')) {
      const lineNumbers = lineNumbersByRawLine.get(line) ?? [];
      lineNumbers.push(lineIndex + FIRST_LINE_NUMBER);
      lineNumbersByRawLine.set(line, lineNumbers);
    }
  }

  const normalizedParsedLines = parsedLines.map((parsedLine) => {
    const lineNumbers = lineNumbersByRawLine.get(parsedLine.raw);
    const lineNumber = lineNumbers?.shift() ?? parsedLine.lineNumber;

    return {
      ...parsedLine,
      lineNumber,
    };
  });
  const parsedLineNumbers = new Set(normalizedParsedLines.map((parsedLine) => parsedLine.lineNumber));
  const fallbackLines = content
    .split(/\r?\n/)
    .map((line, lineIndex) => parseFallbackKernelLine(line, lineIndex + FIRST_LINE_NUMBER))
    .filter((entry): entry is ParsedKernelLine => entry !== undefined)
    .filter((entry) => !parsedLineNumbers.has(entry.lineNumber));

  return [...normalizedParsedLines, ...fallbackLines].sort(
    (leftEntry, rightEntry) => leftEntry.lineNumber - rightEntry.lineNumber,
  );
}

function parseFallbackKernelLine(
  line: string,
  lineNumber: number,
): ParsedKernelLine | undefined {
  const lineMatch = line.match(fallbackKernelLinePattern);

  if (!lineMatch) {
    return undefined;
  }

  const message = lineMatch[FOURTH_CAPTURE_GROUP].trimStart();
  const anchorMatch = message.match(kernelAnchorPattern);

  const priority = Number(lineMatch[FIRST_CAPTURE_GROUP]);
  const relativeTime = lineMatch[SECOND_CAPTURE_GROUP];
  const anchorTimestampMicros = anchorMatch
    ? parseTimestampMicros(anchorMatch[FIRST_CAPTURE_GROUP], anchorMatch[SECOND_CAPTURE_GROUP]) +
      KERNEL_LOG_TIME_OFFSET_MICROS
    : undefined;

  return {
    source: 'kernel',
    lineNumber,
    raw: line,
    priority: kernelPriority(priority),
    message,
    thread: lineMatch[THIRD_CAPTURE_GROUP].trim(),
    tag: extractKernelTag(message),
    kernelLevel: priority,
    relativeSeconds: Number(relativeTime),
    relativeMicros: secondsToMicros(relativeTime),
    ...(anchorTimestampMicros !== undefined ? { anchorTimestampMicros } : {}),
  };
}

function resolveKernelLogLines(
  parsedLines: readonly ParsedKernelLine[],
  options: KernelParseOptions,
): UnifiedLogEntry[] {
  const timeAnchor = findLastKernelAnchor(parsedLines);

  if (!timeAnchor) {
    return handleMissingKernelAnchor(parsedLines, options.missingAnchor ?? DEFAULT_MISSING_ANCHOR_MODE);
  }

  return parsedLines.map((entry) => {
    const timestampMicros = timeAnchor.timestampMicros + entry.relativeMicros - timeAnchor.relativeMicros;

    return {
      ...entry,
      absoluteTime: dateFromMicros(timestampMicros),
      timestampMicros,
      hasTimeAnchor: entry.anchorTimestampMicros !== undefined,
    };
  });
}

function findLastKernelAnchor(
  parsedLines: readonly ParsedKernelLine[],
): { relativeMicros: number; timestampMicros: number } | undefined {
  for (let lineIndex = parsedLines.length - 1; lineIndex >= 0; lineIndex -= 1) {
    const parsedLine = parsedLines[lineIndex];

    if (parsedLine.anchorTimestampMicros !== undefined) {
      return {
        relativeMicros: parsedLine.relativeMicros,
        timestampMicros: parsedLine.anchorTimestampMicros,
      };
    }
  }

  return undefined;
}

function handleMissingKernelAnchor(
  parsedLines: readonly ParsedKernelLine[],
  mode: MissingKernelAnchorMode,
): UnifiedLogEntry[] {
  switch (mode) {
    case 'skip':
      return [];
    case 'relative':
      return parsedLines.map((entry) => ({
        ...entry,
        absoluteTime: dateFromMicros(entry.relativeMicros),
        timestampMicros: entry.relativeMicros,
        hasTimeAnchor: false,
      }));
    case 'throw':
      throw new Error('Kernel log does not contain a UTC;android time anchor');
  }
}

function parseTimestampMicros(dateText: string, timeText: string, options: ParseOptions = {}): number {
  const dateMatch = dateText.match(datePattern);
  const timeMatch = timeText.match(timePattern);

  if (!dateMatch || !timeMatch) {
    throw new Error(`Invalid log timestamp: ${dateText} ${timeText}`);
  }

  const year = Number(dateMatch[YEAR_CAPTURE_GROUP] ?? options.defaultYear ?? new Date().getUTCFullYear());
  const monthIndex = Number(dateMatch[MONTH_CAPTURE_GROUP]) - 1;
  const day = Number(dateMatch[DAY_CAPTURE_GROUP]);
  const hour = Number(timeMatch[HOUR_CAPTURE_GROUP]);
  const minute = Number(timeMatch[MINUTE_CAPTURE_GROUP]);
  const second = Number(timeMatch[SECOND_CAPTURE_GROUP_IN_TIME]);
  const fraction = normalizeMicros(timeMatch[FRACTION_CAPTURE_GROUP]);
  const millisecond = Math.floor(fraction / MICROSECONDS_PER_MILLISECOND);
  const microsecondRemainder = fraction % MICROSECONDS_PER_MILLISECOND;
  const milliseconds = Date.UTC(year, monthIndex, day, hour, minute, second, millisecond);

  return milliseconds * MICROSECONDS_PER_MILLISECOND + microsecondRemainder;
}

function normalizeMicros(fractionText: string): number {
  return Number(
    fractionText.slice(0, MAX_FRACTION_DIGITS).padEnd(MAX_FRACTION_DIGITS, FRACTION_PAD),
  );
}

function secondsToMicros(secondsText: string): number {
  const [wholeSecondsText, fractionText = EMPTY_FRACTION] = secondsText.trim().split('.');

  return (
    Number(wholeSecondsText) * MICROSECONDS_PER_SECOND + normalizeMicros(fractionText || EMPTY_FRACTION)
  );
}

function dateFromMicros(timestampMicros: number): Date {
  return new Date(Math.floor(timestampMicros / MICROSECONDS_PER_MILLISECOND));
}

function kernelPriority(level: number): string {
  if (level <= SECOND_CAPTURE_GROUP) {
    return 'E';
  }

  if (level === THIRD_CAPTURE_GROUP) {
    return 'E';
  }

  if (level === FOURTH_CAPTURE_GROUP) {
    return 'W';
  }

  if (level === FIFTH_CAPTURE_GROUP || level === SIXTH_CAPTURE_GROUP) {
    return 'I';
  }

  return 'D';
}

function extractKernelTag(message: string): string | undefined {
  const tagMatch = message.match(kernelTagPattern);

  return tagMatch ? tagMatch[FIRST_CAPTURE_GROUP] : undefined;
}

function removeTrailingColon(text: string): string {
  const trimmedText = text.trimEnd();

  return (trimmedText.endsWith(':') ? trimmedText.slice(0, -1) : trimmedText).trimEnd();
}

function removeBrackets(text: string): string {
  return text.replace(/^\[/, EMPTY_FRACTION).replace(/\]$/, EMPTY_FRACTION);
}

async function* parseAndroidLogFileEntries(
  filepath: string,
  source: Exclude<LogSource, 'kernel'>,
  options: ParseOptions,
): AsyncGenerator<UnifiedLogEntry> {
  let lines: string[] = [];
  let lineNumberOffset = 0;

  for await (const { line } of readFileLines(filepath)) {
    lines.push(line);

    if (lines.length >= ANDROID_FILE_PARSE_CHUNK_SIZE) {
      yield* parseAndroidLogContent(lines.join('\n'), source, options, lineNumberOffset);
      lineNumberOffset += lines.length;
      lines = [];
    }
  }

  if (lines.length > 0) {
    yield* parseAndroidLogContent(lines.join('\n'), source, options, lineNumberOffset);
  }
}

async function* enumerateLogLines(
  lines: AsyncIterable<LogLineInput> | Iterable<LogLineInput>,
): AsyncGenerator<{ line: string; lineNumber: number }> {
  let fallbackLineNumber = FIRST_LINE_NUMBER;

  for await (const lineInput of lines) {
    const line = typeof lineInput === 'string' ? lineInput : lineInput.line;
    const lineNumber =
      typeof lineInput === 'string' ? fallbackLineNumber : lineInput.lineNumber ?? fallbackLineNumber;

    yield { line, lineNumber };
    fallbackLineNumber = lineNumber + 1;
  }
}

async function* readFileLines(filepath: string): AsyncGenerator<{ line: string; lineNumber: number }> {
  const lineReader = createInterface({
    input: createReadStream(filepath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;

  try {
    for await (const line of lineReader) {
      lineNumber += 1;
      yield { line, lineNumber };
    }
  } finally {
    lineReader.close();
  }
}

function normalizeParseContent(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}
