import { flowShape } from "./simplify";
import type { FlowNode } from "./types";

export const LABEL_COLUMNS = 30;
export const COMMENT_COLUMNS = 34;
export const LABEL_LINE_HEIGHT = 18;
export const COMMENT_LINE_HEIGHT = 16;

export function wrapText(text: string, columns: number): string[] {
  const paragraphs = text.replace(/\t/g, "    ").split(/\r?\n/);
  const lines = paragraphs.flatMap((paragraph) => wrapLine(paragraph.trim(), columns));
  return lines.length ? lines : [""];
}

export function nodeTextLayout(node: FlowNode): { labelLines: string[]; commentLines: string[]; annotationLines: string[] } {
  const shape = flowShape(node);
  const decision = shape === "decision";
  return {
    labelLines: wrapText(node.label, decision ? 19 : shape === "io" ? 29 : shape === "terminator" ? 28 : LABEL_COLUMNS),
    commentLines: node.comments.flatMap((comment) => wrapText(comment, decision ? 23 : COMMENT_COLUMNS)),
    annotationLines: node.annotation ? wrapText(node.annotation, decision ? 23 : COMMENT_COLUMNS) : [],
  };
}

export function nodeContentHeight(node: FlowNode): number {
  const { labelLines, commentLines, annotationLines } = nodeTextLayout(node);
  const extra = (lines: string[]) => lines.length ? 10 + lines.length * COMMENT_LINE_HEIGHT : 0;
  const content = labelLines.length * LABEL_LINE_HEIGHT + extra(commentLines) + extra(annotationLines);
  const shape = flowShape(node);
  const base=shape === "decision" ? Math.max(112, content * 2 + 40) : shape === "terminator" ? Math.max(64, Math.ceil(content * 1.6 + 24)) : Math.max(52, content + 26);
  return base + markerHeight(node);
}

export function markerHeight(node:FlowNode):number {return node.kind==='loop'||node.loop_collapsed||node.flagged?22:0;}

function wrapLine(line: string, columns: number): string[] {
  if (!line) return [""];
  const words = line.split(/\s+/).flatMap((word) => {
    const characters = Array.from(word);
    return Array.from({ length: Math.ceil(characters.length / columns) }, (_, index) => characters.slice(index * columns, (index + 1) * columns).join(""));
  });
  const lines: string[] = [];
  for (const word of words) {
    const current = lines.at(-1);
    if (!current || Array.from(current).length + Array.from(word).length + 1 > columns) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
  }
  return lines;
}
