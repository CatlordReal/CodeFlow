import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import { routePath, type CanvasEdge } from "./layout";

export function FlowEdgePath({ id, data, label, markerEnd, style, selected }: EdgeProps<CanvasEdge>) {
  if (!data?.points.length) return null;
  return <>
    <BaseEdge id={id} path={routePath(data.points)} markerEnd={markerEnd} style={style} />
    {label && <EdgeLabelRenderer><span className={`flow-edge-label ${selected ? "is-selected" : ""}`} style={{ transform: `translate(-50%, -50%) translate(${data.labelPosition.x}px, ${data.labelPosition.y}px)` }}>{label}</span></EdgeLabelRenderer>}
  </>;
}

export const edgeTypes = { flowEdge: FlowEdgePath };
