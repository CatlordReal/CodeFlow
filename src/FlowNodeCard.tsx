import { Handle, Position, type NodeProps } from "@xyflow/react";
import { NODE_WIDTH, nodeHeight, type CanvasNode } from "./layout";
import { nodeTextLayout } from "./textLayout";
import { flowShape } from "./simplify";
import "./flowchart.css";

export default function FlowNodeCard({ data, selected }: NodeProps<CanvasNode>) {
  const { flow } = data;
  const { labelLines, commentLines, annotationLines } = nodeTextLayout(flow);
  const shape = flowShape(flow);
  const height = nodeHeight(flow);
  const isLoop = flow.kind === "loop" || flow.loop_collapsed === true;
  const visual = flow as typeof flow & { flagged?: boolean; unmodified?: boolean };
  const outline = shape === "decision"
    ? <polygon points={`${NODE_WIDTH / 2},1 ${NODE_WIDTH - 1},${height / 2} ${NODE_WIDTH / 2},${height - 1} 1,${height / 2}`} />
    : shape === "io"
      ? <polygon points={`24,1 ${NODE_WIDTH - 1},1 ${NODE_WIDTH - 24},${height - 1} 1,${height - 1}`} />
      : shape === "terminator"
        ? <ellipse cx={NODE_WIDTH / 2} cy={height / 2} rx={NODE_WIDTH / 2 - 1} ry={height / 2 - 1} />
        : <rect x="1" y="1" width={NODE_WIDTH - 2} height={height - 2} />;
  return (
    <div data-kind={flow.kind} data-loop={isLoop || undefined} data-flagged={visual.flagged || undefined} data-unmodified={visual.unmodified || undefined} data-hidden={flow.hidden || undefined} className={`flow-symbol flow-symbol--${shape} ${selected ? "is-selected" : ""}`} style={{ width: NODE_WIDTH, height }} title={`Line ${flow.line}${flow.original_label ? ` · ${flow.original_label}` : ""}${visual.flagged ? " · Flagged for removal" : ""}${visual.unmodified ? " · Unmodified label" : ""}`}>
      <svg className="flow-symbol__outline" viewBox={`0 0 ${NODE_WIDTH} ${height}`} aria-hidden="true">{outline}</svg>
      {shape === "subprocess" && <svg className="flow-symbol__outline flow-symbol__subprocess" viewBox={`0 0 ${NODE_WIDTH} ${height}`} aria-hidden="true"><path d={`M 12 1 V ${height - 1} M ${NODE_WIDTH - 12} 1 V ${height - 1}`} /></svg>}
      {isLoop && <span className="flow-symbol__loop-marker">Loop</span>}
      {visual.flagged && <span className="flow-symbol__flag-marker" aria-label="Flagged for removal" title="Flagged for removal">Flag</span>}
      {([ ["n", Position.Top], ["s", Position.Bottom], ["e", Position.Right], ["w", Position.Left] ] as const).flatMap(([side, position]) => [
        <Handle key={`in-${side}`} id={`in-${side}`} type="target" position={position} isConnectable={false} />,
        <Handle key={`out-${side}`} id={`out-${side}`} type="source" position={position} isConnectable={false} />,
      ])}
      <div className="flow-symbol__content">
        <div className="flow-symbol__label">{labelLines.map((line, index) => <span key={index}>{line || "\u00a0"}</span>)}</div>
        {commentLines.length > 0 && <div className="flow-symbol__comments">{commentLines.map((line, index) => <span key={index}>{line || "\u00a0"}</span>)}</div>}
        {annotationLines.length > 0 && <div className="flow-symbol__annotation">{annotationLines.map((line, index) => <span key={index}>{line || "\u00a0"}</span>)}</div>}
      </div>
    </div>
  );
}
