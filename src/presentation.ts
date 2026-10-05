import type { FlowGraph, FlowNode } from './types';

export type ChartMode = 'code' | 'natural';
export type NodeEdit = { code?: string; natural?: string; annotation?: string };
export type ChartEdits = Record<string, Record<string, NodeEdit>>;
export type CaptionSets = Record<string, Record<string, string>>;

export function naturalLabel(node: FlowNode): string {
  if (node.kind === 'start') return 'Start';
  if (node.kind === 'end') return 'End';
  if (node.shape === 'subprocess') return loopCaption(node.label);
  if (node.kind === 'return') return node.label.replace(/^return\s*/, 'Return ').replace(/;$/, '').trim();
  if (node.kind === 'loop') return loopCaption(node.label);
  if (node.kind === 'throw') return node.label.replace(/^throw\s*/, 'Throw ').replace(/;$/, '').trim();
  if (node.shape === 'decision' || node.kind === 'decision') {
    return 'Is ' + node.label.replace(/^if\s*\((.*)\)$/, '$1').replace(/;$/, '') + ' true?';
  }
  // Keep uncertain operations exact until the user asks AI to paraphrase.
  return node.label.replace(/;(?=\s*$)/gm, '').trim();
}

export function presentGraph(graph: FlowGraph, mode: ChartMode, comments: boolean,
  edits: Record<string, NodeEdit> = {}, captions: Record<string, string> = {}): FlowGraph {
  return { ...graph, nodes: graph.nodes.map(node => ({
    ...node,
    original_label: node.original_label ?? node.label,
    label: edits[node.id]?.[mode] ?? (mode === 'natural' ? captions[node.id] ?? naturalLabel(node) : node.label),
    annotation: edits[node.id]?.annotation ?? '',
    comments: comments ? node.comments : [],
  })) };
}

export type Project = { format: 'codeflow'; version: 1; source: string; fileName: string; mode: ChartMode; edits: ChartEdits; captions: CaptionSets; expandLoops: boolean; includeComments: boolean };
export function readProject(text: string): Project {
  if (text.length > 16 * 1024 * 1024) throw new Error('Project is larger than 16 MB.');
  const value = JSON.parse(text);
  if (value?.format !== 'codeflow' || value.version !== 1 || typeof value.source !== 'string'
    || new TextEncoder().encode(value.source).length > 2 * 1024 * 1024
    || typeof value.fileName !== 'string' || !value.fileName.trim() || value.fileName.length > 240 || /[\x00-\x1f]/.test(value.fileName) || !['code','natural'].includes(value.mode)) throw new Error('Invalid CodeFlow project.');
  const records = (input: unknown, captions: boolean) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid project edits.');
    const validKey = (key: string) => key.length > 0 && key.length <= 160 && !/[\x00-\x1f]/.test(key) && !['__proto__','constructor','prototype'].includes(key);
    for (const [functionKey,set] of Object.entries(input)) {
      if(!validKey(functionKey)) throw new Error('Invalid function key.');
      if (!set || typeof set !== 'object' || Array.isArray(set)) throw new Error('Invalid function edits.');
      for (const [nodeKey,item] of Object.entries(set)) {
        if(!validKey(nodeKey)) throw new Error('Invalid node key.');
        if (captions) {
          if (typeof item !== 'string' || item.length > 500) throw new Error('Invalid saved caption.');
        } else {
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid node edit.');
          for (const [key, label] of Object.entries(item)) {
            if (!['code','natural','annotation'].includes(key) || typeof label !== 'string' || label.length > 2000) throw new Error('Invalid node text.');
          }
        }
      }
    }
  };
  records(value.edits, false); records(value.captions, true);
  value.expandLoops ??= false; value.includeComments ??= false;
  if(typeof value.expandLoops!=='boolean' || typeof value.includeComments!=='boolean') throw new Error('Invalid project view options.');
  return value as Project;
}

export function loopCaption(label: string): string {
  const range = /^for\s*\(.*?\b(\w+)\s*:\s*(.+)\)$/.exec(label);
  if (range) return `For each ${range[1]} in ${range[2]}`;
  const count = /^for\s*\([^;]*?\b(\w+)\s*=\s*([^;]+);\s*([^;]+);\s*(.*?)\)$/.exec(label);
  if (count) return `Loop ${count[1]} from ${count[2]} while ${count[3]}`;
  return label.replace(/^while\s*\((.*)\)$/, 'Repeat while $1').replace(/^do\b/, 'Repeat');
}
