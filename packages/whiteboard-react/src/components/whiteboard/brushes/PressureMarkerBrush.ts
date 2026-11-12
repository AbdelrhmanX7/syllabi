import { Shadow } from 'fabric';

import type { Canvas, Path, PencilBrush } from 'fabric';

import { ScriptBrush } from './ScriptBrush';
import { softMarkerBlur } from './SoftMarkerBrush';

/**
 * The marker with «Pressure» on: the same felt-tip look as {@link SoftMarkerBrush} — see-through ink
 * with a softly blurred edge — but its width follows the hand. A stroked path has ONE width, so this is
 * the script pen's filled outline (blunt ends, half … one and a half of the nib with pressure) wearing
 * the marker's colour and halo. A pen, finger or panel that reports no pressure draws the plain even
 * marker line.
 */
export class PressureMarkerBrush extends ScriptBrush {
  constructor(canvas: Canvas) {
    super(canvas);
    this.tapered = false;
    this.setPressure(true);
  }

  override _render(ctx?: CanvasRenderingContext2D): void {
    const top = this.canvas.contextTop;

    top.save();
    // Device px, untouched by the viewport transform: scaled by hand, as the plain marker does.
    top.shadowColor = this.color;
    top.shadowBlur = softMarkerBlur(this.width) * this.canvas.getZoom() * this.canvas.getRetinaScaling();
    top.shadowOffsetX = 0;
    top.shadowOffsetY = 0;

    try {
      super._render(ctx);
    } finally {
      top.restore();
    }
  }

  override createPath(pathData: Parameters<PencilBrush['createPath']>[0]): Path {
    const path = super.createPath(pathData);

    path.set({ shadow: new Shadow({ color: this.color, blur: softMarkerBlur(this.width), offsetX: 0, offsetY: 0 }) });

    return path;
  }
}
