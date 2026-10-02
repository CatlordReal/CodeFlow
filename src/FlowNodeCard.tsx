import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CanvasNode } from "./layout";
import { nodeTextLayout } from "./textLayout";

const KIND_LABEL: Record<string, string> = {
  start: "Entry",
  end: "Exit",
  decision: "Decision",
  process: "Step",
  return: "Return",
  throw: "Throw",
  break: "Break",
  continue: "Continue",
  switch: "Switch",
};

export default function FlowNodeCard({ data, selected }: NodeProps<CanvasNode>) {
  const { flow } = data;
  const { labelLines, commentLines } = nodeTextLayout(flow);
  return (
    <div className={`flow-node flow-node--${flow.kind} ${selected ? "is-selected" : ""}`}>
      <Handle type="target" position={Position.Top} />
      <div className="flow-node__meta">
        <span>{KIND_LABEL[flow.kind] ?? flow.kind}</span>
        <span>Line {flow.line}</span>
      </div>
      <div className="flow-node__label">
        {labelLines.map((line, index) => <span key={`${flow.id}-label-${index}`}>{line || "\u00a0"}</span>)}
      </div>
      {commentLines.length > 0 && (
        <div className="flow-node__comments">
          {commentLines.map((line, index) => <span key={`${flow.id}-comment-${index}`}>{line || "\u00a0"}</span>)}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
