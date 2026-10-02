import type { FlowNode } from "./types";

export const LABEL_COLUMNS = 28;
export const COMMENT_COLUMNS = 38;
export const LABEL_LINE_HEIGHT = 17;
export const COMMENT_LINE_HEIGHT = 16;

export function wrapText(text: string, columns: number): string[] {
  const paragraphs = text.replace(/\t/g, "    ").split(/\r?\n/);
  const lines = paragraphs.flatMap((paragraph) => wrapLine(paragraph.trim(), columns));
  return lines.length > 0 ? lines : [""];
}

export function nodeTextLayout(node: FlowNode): { labelLines: string[]; commentLines: string[] } {
  return {
    labelLines: wrapText(node.label, LABEL_COLUMNS),
    commentLines: node.comments.flatMap((comment) => wrapText(comment, COMMENT_COLUMNS)),
  };
}

export function nodeContentHeight(node: FlowNode): number {
  const { labelLines, commentLines } = nodeTextLayout(node);
  const commentsHeight = commentLines.length > 0 ? 18 + commentLines.length * COMMENT_LINE_HEIGHT : 0;
  return Math.max(80, 50 + labelLines.length * LABEL_LINE_HEIGHT + commentsHeight);
}

function wrapLine(line: string, columns: number): string[] {
  if (!line) return [""];
  const words = line.split(/\s+/).flatMap((word) => splitLongWord(word, columns));
  const lines: string[] = [];
  for (const word of words) {
    const current = lines.at(-1);
    if (!current || Array.from(current).length + Array.from(word).length + 1 > columns) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
  }
  return lines;
}

function splitLongWord(word: string, columns: number): string[] {
  const characters = Array.from(word);
  if (characters.length <= columns) return [word];
  return Array.from({ length: Math.ceil(characters.length / columns) }, (_, index) => characters.slice(index * columns, (index + 1) * columns).join(""));
}
