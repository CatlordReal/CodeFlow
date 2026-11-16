import type { FlowNode, FunctionInfo } from './types';

type SourceSpan = { start_byte?: number; end_byte?: number };
function contains(span: SourceSpan, byte: number): boolean {
  const { start_byte: start, end_byte: end } = span;
  return Number.isSafeInteger(byte) && byte >= 0 && Number.isSafeInteger(start) && Number.isSafeInteger(end)
    && start! >= 0 && end! > start! && byte >= start! && byte < end!;
}
function width(span: SourceSpan): number { return span.end_byte! - span.start_byte!; }

/** Find the innermost definition containing a UTF-8 byte offset. */
export function functionAtByte(functions: readonly FunctionInfo[], byte: number): FunctionInfo | undefined {
  return functions.filter(item => contains(item, byte)).sort((a, b) => width(a) - width(b))[0];
}

/** Prefer source operations over synthetic start/end nodes, then the narrowest span. */
export function nodeAtByte(nodes: readonly FlowNode[], byte: number): FlowNode | undefined {
  const matches = nodes.filter(item => contains(item, byte));
  return matches.sort((a, b) => Number(['start', 'end'].includes(a.kind)) - Number(['start', 'end'].includes(b.kind)) || width(a) - width(b))[0];
}
