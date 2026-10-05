import type { FlowEdge, FlowGraph, FlowNode } from "./types";

/** Conventional symbols; the analyzer remains the authority for control flow. */
export function flowShape(node: FlowNode): NonNullable<FlowNode["shape"]> {
  if (node.shape) return node.shape;
  if (["start", "end", "return", "throw"].includes(node.kind)) return "terminator";
  if (["decision", "loop", "switch"].includes(node.kind)) return "decision";
  if (node.kind === "io" || (node.kind === "process" && node.label.split("\n").every(isIoStatement))) return "io";
  return "process";
}

function isIoStatement(label: string): boolean {
  return /^(?:(?:std::)?(?:cout|cerr|clog|cin|wcout|wcerr|wcin)\s*(?:<<|>>)|(?:std::)?(?:printf|fprintf|scanf|fscanf|puts|putchar|getchar|getline)\s*\()/u.test(label.trim());
}

/** Collapse connectors/jumps, prune unreachable nodes, and group linear steps. */
export function simplifyGraph(graph: FlowGraph): FlowGraph {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, FlowEdge[]>();
  for (const edge of graph.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  }
  const roots = graph.nodes.filter((node) => node.kind === "start");
  const reachable = new Set<string>();
  const pending = (roots.length ? roots : graph.nodes.slice(0, 1)).map((node) => node.id);
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of outgoing.get(id) ?? []) pending.push(edge.target);
  }
  // Real break/continue statements are represented by their destination edges.
  const hidden = new Set(graph.nodes.filter((node) => ["merge", "break", "continue"].includes(node.kind)).map((node) => node.id));
  let nodes = graph.nodes.filter((node) => reachable.has(node.id) && !hidden.has(node.id)).map((node) => ({
    ...node, comments: [...node.comments], shape: flowShape(node), source_ids: node.source_ids ?? [node.id],
    ...(node.kind === "start" ? { label: "Start", original_label: node.original_label ?? node.label } : {}),
  }));
  const edges: FlowEdge[] = [];
  for (const node of nodes) {
    const walk = (edge: FlowEdge, label: string, visited: Set<string>) => {
      const nextLabel = joinLabels(label, edge.label);
      if (!hidden.has(edge.target)) {
        if (reachable.has(edge.target)) edges.push({ ...edge, id: `${node.id}-${edge.target}-${edges.length}`, source: node.id, label: nextLabel });
        return;
      }
      if (visited.has(edge.target)) return;
      const nextVisited = new Set(visited).add(edge.target);
      for (const next of outgoing.get(edge.target) ?? []) walk(next, nextLabel, nextVisited);
    };
    for (const edge of outgoing.get(node.id) ?? []) walk(edge, "", new Set());
  }
  // Retain comments attached to removed connector/jump nodes at their destination.
  for (const removed of graph.nodes.filter((node) => reachable.has(node.id) && hidden.has(node.id) && node.comments.length)) {
    const queue = (outgoing.get(removed.id) ?? []).map((edge) => edge.target);
    const visited = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const target = nodes.find((node) => node.id === id);
      if (target) { target.comments = [...new Set([...removed.comments, ...target.comments])]; break; }
      queue.push(...(outgoing.get(id) ?? []).map((edge) => edge.target));
    }
  }
  let uniqueEdges = deduplicateEdges(edges);
  // The parser already groups most adjacent statements. Support imported graphs too.
  let changed = true;
  while (changed) {
    changed = false;
    for (const first of nodes) {
      if (first.kind !== "process") continue;
      const exits = uniqueEdges.filter((edge) => edge.source === first.id);
      if (exits.length !== 1 || exits[0].label || exits[0].target === first.id) continue;
      const second = nodes.find((node) => node.id === exits[0].target);
      if (!second || second.kind !== "process" || second.shape !== first.shape || second.start_byte < first.end_byte) continue;
      if (uniqueEdges.filter((edge) => edge.target === second.id).length !== 1) continue;
      first.label += `\n${second.label}`;
      first.end_byte = second.end_byte;
      first.comments = [...first.comments, ...second.comments];
      first.source_ids = [...first.source_ids, ...second.source_ids];
      nodes = nodes.filter((node) => node.id !== second.id);
      uniqueEdges = uniqueEdges.filter((edge) => edge.id !== exits[0].id).map((edge) => ({ ...edge, source: edge.source === second.id ? first.id : edge.source }));
      changed = true;
      break;
    }
  }
  // Mixed blocks must be split so IO never becomes an ordinary process rectangle.
  const splitNodes: FlowNode[] = [];
  for (const node of nodes) {
    if (node.kind !== "process" || node.original_label) { splitNodes.push(node); continue; }
    const chunks: { shape: "io" | "process"; lines: string[] }[] = [];
    for (const line of node.label.split("\n")) {
      const shape = isIoStatement(line) ? "io" : "process";
      if (chunks.at(-1)?.shape === shape) chunks.at(-1)!.lines.push(line);
      else chunks.push({ shape, lines: [line] });
    }
    if (chunks.length < 2) { splitNodes.push(node); continue; }
    const parts = chunks.map((chunk, index) => ({ ...node, id: index ? `${node.id}-part-${index}` : node.id, shape: chunk.shape, label: chunk.lines.join("\n"), comments: index ? [] : node.comments }));
    splitNodes.push(...parts);
    uniqueEdges = uniqueEdges.map((edge) => edge.source === node.id ? { ...edge, source: parts.at(-1)!.id } : edge);
    for (let index = 1; index < parts.length; index++) uniqueEdges.push({ id: `${node.id}-part-edge-${index}`, source: parts[index - 1].id, target: parts[index].id, label: "" });
  }
  return { ...graph, nodes: splitNodes, edges: deduplicateEdges(uniqueEdges) };
}

function joinLabels(first: string, second: string): string {
  const labels = [first, second].filter((label) => label && label !== "Repeat" && label !== "Fallthrough");
  return [...new Set(labels)].join(" / ");
}

function deduplicateEdges(edges: FlowEdge[]): FlowEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = JSON.stringify([edge.source, edge.target, edge.label]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Summarize only structured loops with one entry and one normal exit. */
export function overviewGraph(graph: FlowGraph): FlowGraph {
  let nodes = graph.nodes.map((node) => ({ ...node, comments: [...node.comments], source_ids: [...(node.source_ids ?? [node.id])] }));
  let edges = graph.edges.map((edge) => ({ ...edge }));
  // Outer loops first: a nested loop belongs to the same predefined process.
  const candidates = graph.nodes.filter((node) => node.kind === "loop" && node.end_byte > node.start_byte)
    .sort((a, b) => (b.end_byte - b.start_byte) - (a.end_byte - a.start_byte));
  for (const candidate of candidates) {
    const header = nodes.find((node) => node.id === candidate.id && node.kind === "loop");
    if (!header) continue;
    const within = (node: FlowNode) => node.start_byte >= header.start_byte && node.end_byte <= header.end_byte;
    const members = nodes.filter(within);
    if (members.length < 2 || members.some((node) => ["start", "end", "return", "throw"].includes(node.kind))) continue;
    // Enclosing control statements legitimately cover the interval; a statement
    // starting inside it and ending outside it cannot belong to this subprocess.
    if (nodes.some((node) => node.start_byte >= header.start_byte && node.start_byte < header.end_byte && node.end_byte > header.end_byte)) continue;
    const ids = new Set(members.map((node) => node.id));
    const incoming = edges.filter((edge) => !ids.has(edge.source) && ids.has(edge.target));
    const outgoing = edges.filter((edge) => ids.has(edge.source) && !ids.has(edge.target));
    if (!incoming.length || incoming.some((edge) => edge.target !== header.id)) continue;
    if (new Set(outgoing.map((edge) => edge.target)).size !== 1) continue;
    const reachable = new Set<string>();
    const queue = [header.id];
    while (queue.length) {
      const id = queue.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      queue.push(...edges.filter((edge) => edge.source === id && ids.has(edge.target)).map((edge) => edge.target));
    }
    if (reachable.size !== ids.size) continue;
    const collapsed: FlowNode = {
      ...header, kind: "process", shape: "subprocess", original_label: header.original_label ?? header.label,
      source_ids: [...new Set(members.flatMap((node) => node.source_ids))],
      comments: [...new Set(members.flatMap((node) => node.comments))],
    };
    nodes = nodes.flatMap((node) => node.id === header.id ? [collapsed as typeof header] : ids.has(node.id) ? [] : [node]);
    // The loop's internal No/break condition has finished; the subprocess has one
    // ordinary completion edge, while external incoming branch labels stay exact.
    edges = edges.filter((edge) => !ids.has(edge.source));
    const exit = outgoing.find((edge) => edge.source === header.id) ?? outgoing[0];
    edges.push({ ...exit, source: header.id, label: "" });
  }
  return { ...graph, nodes, edges: deduplicateEdges(edges) };
}
