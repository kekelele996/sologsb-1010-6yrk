import type { TextbookLine } from './types';

export type LineAlignmentKind = 'equal' | 'replace' | 'insert' | 'remove';

export interface LineAlignment {
  kind: LineAlignmentKind;
  oldLine?: TextbookLine;
  newSource?: string;
  newIndex?: number;
}

export function splitImportedText(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split(/\n+|(?<=[.!?。！？])\s+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function alignLines(oldLines: TextbookLine[], newSources: string[]): LineAlignment[] {
  const commonLength = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newSources.length + 1).fill(0));

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newSources.length - 1; newIndex >= 0; newIndex -= 1) {
      commonLength[oldIndex][newIndex] = oldLines[oldIndex].source === newSources[newIndex]
        ? commonLength[oldIndex + 1][newIndex + 1] + 1
        : Math.max(commonLength[oldIndex + 1][newIndex], commonLength[oldIndex][newIndex + 1]);
    }
  }

  const matches: Array<{ oldIndex: number; newIndex: number }> = [];
  let oldCursor = 0;
  let newCursor = 0;
  while (oldCursor < oldLines.length && newCursor < newSources.length) {
    if (oldLines[oldCursor].source === newSources[newCursor]) {
      matches.push({ oldIndex: oldCursor, newIndex: newCursor });
      oldCursor += 1;
      newCursor += 1;
    } else if (commonLength[oldCursor + 1][newCursor] > commonLength[oldCursor][newCursor + 1]) {
      oldCursor += 1;
    } else if (commonLength[oldCursor][newCursor + 1] > commonLength[oldCursor + 1][newCursor]) {
      newCursor += 1;
    } else if (oldLines.length - oldCursor > newSources.length - newCursor) {
      oldCursor += 1;
    } else {
      newCursor += 1;
    }
  }

  const result: LineAlignment[] = [];
  let oldStart = 0;
  let newStart = 0;

  const similarity = (left: string, right: string): number => {
    const a = left.toLocaleLowerCase();
    const b = right.toLocaleLowerCase();
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;

    const distances = Array.from({ length: a.length + 1 }, (_, index) => [index, ...new Array<number>(b.length).fill(0)]);
    for (let column = 0; column <= b.length; column += 1) distances[0][column] = column;

    for (let row = 1; row <= a.length; row += 1) {
      for (let column = 1; column <= b.length; column += 1) {
        const cost = a[row - 1] === b[column - 1] ? 0 : 1;
        distances[row][column] = Math.min(
          distances[row - 1][column] + 1,
          distances[row][column - 1] + 1,
          distances[row - 1][column - 1] + cost,
        );
      }
    }

    return 1 - distances[a.length][b.length] / Math.max(a.length, b.length);
  };

  const appendGap = (oldEnd: number, newEnd: number) => {
    const oldGap = oldLines.slice(oldStart, oldEnd);
    const newGap = newSources.slice(newStart, newEnd);
    const scores = oldGap.map((oldLine) => newGap.map((source) => similarity(oldLine.source, source)));
    const pairThreshold = 0.45;
    const scoreTable = Array.from({ length: oldGap.length + 1 }, () => new Array<number>(newGap.length + 1).fill(0));

    for (let oldIndex = oldGap.length - 1; oldIndex >= 0; oldIndex -= 1) {
      for (let newIndex = newGap.length - 1; newIndex >= 0; newIndex -= 1) {
        scoreTable[oldIndex][newIndex] = Math.max(
          scoreTable[oldIndex + 1][newIndex],
          scoreTable[oldIndex][newIndex + 1],
          scores[oldIndex][newIndex] >= pairThreshold
            ? scoreTable[oldIndex + 1][newIndex + 1] + 1 + scores[oldIndex][newIndex]
            : -1,
        );
      }
    }

    const operations: LineAlignment[] = [];
    let oldIndex = 0;
    let newIndex = 0;
    while (oldIndex < oldGap.length || newIndex < newGap.length) {
      const canPair = oldIndex < oldGap.length
        && newIndex < newGap.length
        && scores[oldIndex][newIndex] >= pairThreshold;
      const pairScore = canPair
        ? scoreTable[oldIndex + 1][newIndex + 1] + 1 + scores[oldIndex][newIndex]
        : -Infinity;
      const insertScore = newIndex < newGap.length ? scoreTable[oldIndex][newIndex + 1] : -Infinity;
      const removeScore = oldIndex < oldGap.length ? scoreTable[oldIndex + 1][newIndex] : -Infinity;

      if (pairScore >= insertScore && pairScore >= removeScore) {
        operations.push({ kind: 'replace', oldLine: oldGap[oldIndex], newSource: newGap[newIndex], newIndex: newStart + newIndex });
        oldIndex += 1;
        newIndex += 1;
      } else if (insertScore >= removeScore) {
        operations.push({ kind: 'insert', newSource: newGap[newIndex], newIndex: newStart + newIndex });
        newIndex += 1;
      } else {
        operations.push({ kind: 'remove', oldLine: oldGap[oldIndex] });
        oldIndex += 1;
      }
    }
    result.push(...operations);
  };

  matches.forEach((match) => {
    appendGap(match.oldIndex, match.newIndex);
    result.push({
      kind: 'equal',
      oldLine: oldLines[match.oldIndex],
      newSource: newSources[match.newIndex],
      newIndex: match.newIndex,
    });
    oldStart = match.oldIndex + 1;
    newStart = match.newIndex + 1;
  });
  appendGap(oldLines.length, newSources.length);

  return result;
}
