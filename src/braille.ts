import type {
  BrailleToken,
  ProofIssue,
  ProjectState,
  RemovedLine,
  RuleSet,
  TextbookLine,
  TranscriptionRule,
} from './types';

const LETTERS: Record<string, string> = {
  a: '⠁', b: '⠃', c: '⠉', d: '⠙', e: '⠑', f: '⠋', g: '⠛', h: '⠓', i: '⠊', j: '⠚',
  k: '⠅', l: '⠇', m: '⠍', n: '⠝', o: '⠕', p: '⠏', q: '⠟', r: '⠗', s: '⠎', t: '⠞',
  u: '⠥', v: '⠧', w: '⠺', x: '⠭', y: '⠽', z: '⠵',
};

const DEFAULT_PUNCTUATION: Record<string, string> = {
  ',': '⠂', ';': '⠆', ':': '⠒', '.': '⠲', '!': '⠖', '?': '⠦', '(': '⠐⠣', ')': '⠐⠜',
  '-': '⠤', '—': '⠠⠤', '"': '⠦', "'": '⠄', '/': '⠸⠌', '&': '⠈⠯', '@': '⠈⠁',
};

const DIGITS: Record<string, string> = {
  '0': '⠚', '1': '⠁', '2': '⠃', '3': '⠉', '4': '⠙', '5': '⠑', '6': '⠋', '7': '⠛', '8': '⠓', '9': '⠊',
};

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function activeRule(ruleSet: RuleSet, source: string, kind: TranscriptionRule['kind']): TranscriptionRule | undefined {
  return ruleSet.rules.find((rule) => rule.enabled && rule.kind === kind && rule.source.toLocaleLowerCase() === source.toLocaleLowerCase());
}

function matchContraction(ruleSet: RuleSet, source: string, index: number): TranscriptionRule | undefined {
  if (!ruleSet.contractions) return undefined;
  const before = source[index - 1] ?? '';
  if (/[\p{L}\p{N}]/u.test(before)) return undefined;

  const candidates = ruleSet.rules
    .filter((rule) => rule.enabled && rule.kind === 'contraction')
    .sort((a, b) => b.source.length - a.source.length);

  const rest = source.slice(index).toLocaleLowerCase();
  return candidates.find((rule) => rest.startsWith(rule.source.toLocaleLowerCase()));
}

function addToken(
  tokens: BrailleToken[],
  text: string,
  braille: string,
  kind: BrailleToken['kind'],
  offset: number,
  rule?: TranscriptionRule,
): void {
  tokens.push({
    id: uid('token'),
    text,
    braille,
    kind,
    ruleId: rule?.id,
    suspicious: Boolean(rule?.suspicious),
    offset,
  });
}

export function transcribeLine(source: string, ruleSet: RuleSet, continuesPrevious = false): BrailleToken[] {
  const tokens: BrailleToken[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const lower = char.toLocaleLowerCase();

    if (/\s/u.test(char)) {
      addToken(tokens, char, ' ', 'special', index);
      index += 1;
      continue;
    }

    const contraction = matchContraction(ruleSet, source, index);
    if (contraction) {
      addToken(tokens, source.slice(index, index + contraction.source.length), contraction.output, 'contraction', index, contraction);
      index += contraction.source.length;
      continue;
    }

    if (/\d/u.test(char)) {
      const start = index;
      let number = '';
      while (index < source.length && /\d/u.test(source[index])) {
        number += source[index];
        index += 1;
      }
      const numberRule = activeRule(ruleSet, '#', 'number');
      addToken(tokens, number, `${numberRule?.output ?? '⠼'}${[...number].map((digit) => DIGITS[digit]).join('')}`, 'number', start, numberRule);
      continue;
    }

    if (/[A-Z]/u.test(char)) {
      const capitalRule = activeRule(ruleSet, 'capital', 'special');
      addToken(tokens, char, `${capitalRule?.output ?? '⠠'}${LETTERS[lower]}`, 'letter', index, capitalRule);
      index += 1;
      continue;
    }

    if (/[a-z]/iu.test(char)) {
      const rule = activeRule(ruleSet, lower, 'letter');
      const output = rule?.output ?? LETTERS[lower] ?? '⠿';
      addToken(tokens, char, output, 'letter', index, rule);
      if (!rule) {
        addToken(tokens, '', '⟦未配置⟧', 'special', index);
      }
      index += 1;
      continue;
    }

    const punctuation = activeRule(ruleSet, char, 'punctuation') ?? activeRule(ruleSet, char.toLocaleLowerCase(), 'punctuation');
    if (punctuation) {
      addToken(tokens, char, punctuation.output, 'punctuation', index, punctuation);
      index += 1;
      continue;
    }

    const fallback = DEFAULT_PUNCTUATION[char];
    addToken(tokens, char, fallback ?? '⠿', 'punctuation', index);
    if (!fallback) addToken(tokens, '', '⟦无对应规则⟧', 'special', index);
    index += 1;
  }

  if (source.trimEnd().endsWith('-')) {
    addToken(tokens, '', ruleSet.hyphenMode === 'cross-line' ? '⠤↳' : '⠤', 'special', Math.max(0, source.length - 1));
  }

  if (continuesPrevious) {
    tokens.unshift({
      id: uid('token'),
      text: '',
      braille: '↳ ',
      kind: 'special',
      suspicious: true,
      offset: 0,
    });
  }

  return tokens;
}

function issue(
  line: TextbookLine,
  code: string,
  message: string,
  severity: ProofIssue['severity'],
  token?: BrailleToken,
): ProofIssue {
  return {
    id: uid('issue'),
    lineId: line.id,
    tokenId: token?.id,
    ruleId: token?.ruleId,
    severity,
    code,
    message,
    resolved: false,
  };
}

function analyzeLine(line: TextbookLine, previousLine?: TextbookLine): { line: TextbookLine; issues: ProofIssue[] } {
  const issues: ProofIssue[] = [];
  const tokenText = line.tokens.map((token) => token.braille).join('');
  const hasContinuation = line.source.trimEnd().endsWith('-');
  const previousContinues = Boolean(previousLine?.source.trimEnd().endsWith('-'));
  const nextLine = {
    ...line,
    continuesPrevious: previousContinues,
    continuesNext: hasContinuation,
  };

  if (hasContinuation) {
    issues.push(issue(nextLine, 'cross-line-hyphen', '此行以连字符结尾，已插入跨行连接标记；请核对断词位置。', 'warning', nextLine.tokens.at(-1)));
  }

  for (const token of nextLine.tokens) {
    if (token.suspicious) {
      issues.push(issue(nextLine, 'suspicious-rule', `规则“${token.text}”被标记为可疑转写。`, 'warning', token));
    }
    if (token.text && token.braille.includes('⟦')) {
      issues.push(issue(nextLine, 'unknown-symbol', `“${token.text}”没有可用的转写规则。`, 'error', token));
    }
  }

  if (tokenText.replace(/\s/g, '').length > 42) {
    issues.push(issue(nextLine, 'line-too-long', `盲文结果为 ${tokenText.replace(/\s/g, '').length} 格，建议重新分词。`, 'info'));
  }

  if (hasContinuation && nextLine.source.trimEnd().split(/\s+/).at(-1)?.replace(/-$/, '').length === 1) {
    issues.push(issue(nextLine, 'orphan-fragment', '断词后仅剩一个字母，教学排版中通常应整体移到下一行。', 'warning'));
  }

  if (issues.some((item) => item.severity === 'error')) {
    nextLine.status = 'questionable';
  } else if (issues.length > 0 && nextLine.status === 'unchecked') {
    nextLine.status = 'questionable';
  }

  return { line: nextLine, issues };
}

export function analyzeProject(state: ProjectState): ProjectState {
  const ruleSet = state.ruleSets.find((item) => item.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const nextLines: TextbookLine[] = [];
  const issues: ProofIssue[] = [];

  state.lines.forEach((line, index) => {
    const previousSourceContinues = Boolean(state.lines[index - 1]?.source.trimEnd().endsWith('-'));
    const tokens = transcribeLine(line.source, ruleSet, previousSourceContinues);
    const analyzed = analyzeLine({ ...line, tokens }, state.lines[index - 1]);
    nextLines.push(analyzed.line);
    issues.push(...analyzed.issues);
  });

  return {
    ...state,
    lines: nextLines,
    issues,
    lastCheckedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function updateRuleInSet(ruleSet: RuleSet, ruleId: string, patch: Partial<TranscriptionRule>): RuleSet {
  return {
    ...ruleSet,
    rules: ruleSet.rules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)),
  };
}

type DiffOp =
  | { type: 'equal'; oldIndex: number }
  | { type: 'remove'; oldIndex: number }
  | { type: 'add'; newIndex: number };

/** 基于 LCS 的逐行 diff，按原文完全匹配对齐新旧两批行。 */
function diffSources(oldSources: string[], newSources: string[]): DiffOp[] {
  const rows = oldSources.length;
  const cols = newSources.length;
  const dp: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      dp[i][j] = oldSources[i] === newSources[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldSources[i] === newSources[j]) {
      ops.push({ type: 'equal', oldIndex: i });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'remove', oldIndex: i });
      i += 1;
    } else {
      ops.push({ type: 'add', newIndex: j });
      j += 1;
    }
  }
  while (i < rows) ops.push({ type: 'remove', oldIndex: i++ });
  while (j < cols) ops.push({ type: 'add', newIndex: j++ });
  return ops;
}

export interface ImportMergeResult {
  lines: TextbookLine[];
  removed: RemovedLine[];
  /** 原文未变的行 id，这些行的状态、备注和问题处理记录全部沿用。 */
  preservedLineIds: string[];
}

function wordsOf(text: string): Set<string> {
  return new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** 词级 Jaccard 相似度，用于判断“删一行 + 增一行”是否其实是同一行被修改。 */
function lineSimilarity(a: string, b: string): number {
  const wordsA = wordsOf(a);
  const wordsB = wordsOf(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  wordsA.forEach((word) => { if (wordsB.has(word)) shared += 1; });
  return shared / (wordsA.size + wordsB.size - shared);
}

/** 低于该相似度的删/增对不视为修改，避免把无关的移除行和新增行错误配对。 */
const REVISION_SIMILARITY = 0.3;

/**
 * 把修订版课文逐行合并进现有教材：
 * - 原文相同的行原样保留（状态、备注、问题记录不动）；
 * - 相邻且足够相似的“删一行 + 增一行”视为同一行被修改：保留行 id 和备注，状态回到待核对，并记录旧原文用于对照；
 * - 纯新增行生成待检查的新行；
 * - 纯被移除的行进入待确认区，确认前不移出教材。
 */
export function mergeImportedLines(oldLines: TextbookLine[], newSources: string[]): ImportMergeResult {
  const ops = diffSources(oldLines.map((line) => line.source), newSources);
  const lines: TextbookLine[] = [];
  const removed: RemovedLine[] = [];
  const preservedLineIds: string[] = [];
  let pendingRemovals: number[] = [];
  let pendingAdds: number[] = [];

  const flushBlock = () => {
    const pairedSlots = new Set<number>();
    for (const newIndex of pendingAdds) {
      const source = newSources[newIndex];
      let bestSlot = -1;
      let bestScore = 0;
      pendingRemovals.forEach((oldIndex, slot) => {
        if (pairedSlots.has(slot)) return;
        const score = lineSimilarity(oldLines[oldIndex].source, source);
        if (score > bestScore) {
          bestSlot = slot;
          bestScore = score;
        }
      });
      if (bestSlot >= 0 && bestScore >= REVISION_SIMILARITY) {
        pairedSlots.add(bestSlot);
        const old = oldLines[pendingRemovals[bestSlot]];
        lines.push({ ...old, source, status: 'questionable', previousSource: old.source });
      } else {
        lines.push({ id: uid('line'), source, tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false });
      }
    }
    pendingRemovals.forEach((oldIndex, slot) => {
      if (!pairedSlots.has(slot)) {
        removed.push({ id: uid('removed'), line: oldLines[oldIndex], index: oldIndex, removedAt: new Date().toISOString(), issues: [] });
      }
    });
    pendingRemovals = [];
    pendingAdds = [];
  };

  for (const op of ops) {
    if (op.type === 'remove') {
      pendingRemovals.push(op.oldIndex);
      continue;
    }
    if (op.type === 'add') {
      pendingAdds.push(op.newIndex);
      continue;
    }
    flushBlock();
    const old = oldLines[op.oldIndex];
    preservedLineIds.push(old.id);
    lines.push(old);
  }
  flushBlock();
  return { lines, removed, preservedLineIds };
}

/** 重新分析后，把指定行里内容未变的问题恢复为“已处理”，避免丢失问题处理记录。 */
export function carryResolvedIssues(previous: ProofIssue[], next: ProofIssue[], lineIds: Set<string>): ProofIssue[] {
  const resolvedKeys = new Set(
    previous.filter((item) => item.resolved && lineIds.has(item.lineId)).map((item) => `${item.lineId}|${item.code}|${item.message}`),
  );
  if (resolvedKeys.size === 0) return next;
  return next.map((item) => (resolvedKeys.has(`${item.lineId}|${item.code}|${item.message}`) ? { ...item, resolved: true } : item));
}

export function makeRule(source: string, output: string, suspicious: boolean, kind: TranscriptionRule['kind'] = 'contraction'): TranscriptionRule {
  return {
    id: uid('rule'),
    source,
    output,
    kind,
    enabled: true,
    suspicious,
    description: '自定义规则',
  };
}

export function outputText(state: ProjectState): string {
  return state.lines.map((line, index) => `${String(index + 1).padStart(3, '0')}  ${line.tokens.map((token) => token.braille).join('')}`).join('\n');
}

export function brailleCellCount(state: ProjectState): number {
  return state.lines.reduce((total, line) => total + line.tokens.reduce((count, token) => count + token.braille.replace(/\s/g, '').length, 0), 0);
}
