export type FunctionInfo = {
  id: string;
  name: string;
  line: number;
  identity?: string;
  qualified_name?: string;
};

export type FlowNode = {
  id: string;
  label: string;
  kind: string;
  line: number;
  start_byte: number;
  end_byte: number;
  comments: string[];
  shape?: "terminator" | "decision" | "process" | "io" | "subprocess";
  source_ids?: string[];
  source_identity?: string;
  header_identity?: string | null;
  loop_condition?: string | null;
  original_label?: string;
  annotation?: string;
  hidden?: boolean;
  flagged?: boolean;
  unmodified?: boolean;
  loop_id?: string;
  loop_depth?: number;
  loop_collapsed?: boolean;
  loop_can_collapse?: boolean;
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
