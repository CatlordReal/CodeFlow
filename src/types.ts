export type FunctionInfo = {
  id: string;
  name: string;
  line: number;
};

export type FlowNode = {
  id: string;
  label: string;
  kind: string;
  line: number;
  start_byte: number;
  end_byte: number;
  comments: string[];
};

export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
};

export type FlowGraph = {
  nodes: FlowNode[];
  edges: FlowEdge[];
  diagnostics: string[];
};
