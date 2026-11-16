import { useViewport } from '@xyflow/react';
import type { AlignmentGuide } from './boxGeometry';

export default function AlignmentGuides({ guides }: { guides: AlignmentGuide[] }) {
  const { x, y, zoom } = useViewport();
  return <svg className="alignment-guides" aria-hidden="true">
    <g transform={`translate(${x} ${y}) scale(${zoom})`}>
      {guides.map((guide, index) => <line key={index}
        x1={guide.axis === 'x' ? guide.value : guide.from}
        x2={guide.axis === 'x' ? guide.value : guide.to}
        y1={guide.axis === 'y' ? guide.value : guide.from}
        y2={guide.axis === 'y' ? guide.value : guide.to}
        stroke="var(--accent)" strokeWidth={1 / zoom} strokeDasharray={`${4 / zoom} ${3 / zoom}`} />)}
    </g>
  </svg>;
}
