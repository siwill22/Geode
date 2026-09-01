import GUI, { type Controller } from 'lil-gui';
import type { ClimateLayer } from './climateInstance';
import type { ColormapData, VariableInfo } from '../core/types';

export interface ClimateViewState {
  layer: ClimateLayer;
  age: number;
  clipMin: number;
  clipMax: number;
}

export interface ClimateUICallbacks {
  onLayer(layer: ClimateLayer): void;
  onAge(age: number): void;
  onClip(lo: number, hi: number): void;
}

/**
 * A deliberately small panel: layer choice, age, colour clip range, a
 * legend, and status text. No model/variable dropdown beyond the layer
 * toggle, no cutaway/isosurface/sinking-rate folders -- those are tomography
 * concepts with no climate equivalent, kept out rather than disabled.
 */
export class ClimateUI {
  readonly gui: GUI;
  private layerCtrl: Controller;
  private ageCtrl: Controller;
  private clipMinCtrl: Controller;
  private clipMaxCtrl: Controller;
  private status: HTMLDivElement;
  private timeInfo: HTMLDivElement;
  private legend: HTMLDivElement;
  private legendLabel: HTMLDivElement;
  private legendCanvas: HTMLCanvasElement;

  constructor(
    private state: ClimateViewState,
    private cb: ClimateUICallbacks,
    title = 'Geode Paleoclimate',
  ) {
    this.gui = new GUI({ title });
    this.layerCtrl = this.gui
      .add(this.state, 'layer', { Temperature: 'climate', Paleogeography: 'paleogeography' })
      .name('layer')
      .onChange((v: ClimateLayer) => cb.onLayer(v));
    this.ageCtrl = this.gui.add(this.state, 'age', 0, 540, 1)
      .name('age (Ma)')
      .onChange((v: number) => cb.onAge(v));
    this.clipMinCtrl = this.gui.add(this.state, 'clipMin', -60, 50, 0.1)
      .name('clip min')
      .onChange(() => cb.onClip(this.state.clipMin, this.state.clipMax));
    this.clipMaxCtrl = this.gui.add(this.state, 'clipMax', -60, 50, 0.1)
      .name('clip max')
      .onChange(() => cb.onClip(this.state.clipMin, this.state.clipMax));

    this.status = document.createElement('div');
    this.status.className = 'status';
    document.body.appendChild(this.status);
    this.setStatus('');

    this.timeInfo = document.createElement('div');
    this.timeInfo.className = 'timeinfo';
    document.body.appendChild(this.timeInfo);
    this.setTimeInfo('');

    this.legend = document.createElement('div');
    this.legend.className = 'legend';
    this.legendLabel = document.createElement('div');
    this.legendLabel.className = 'legend-label';
    this.legendCanvas = document.createElement('canvas');
    this.legendCanvas.className = 'legend-ramp';
    this.legendCanvas.width = 256;
    this.legendCanvas.height = 12;
    this.legend.append(this.legendLabel, this.legendCanvas);
    document.body.appendChild(this.legend);
  }

  /** Bound by the manifest's own frame range (0-540 Ma) -- NOT
   *  archive.coastlines.age_max (200 Ma), which only bounds the paleogeography
   *  overlay, a narrower thing. See ClimateInstance's class doc. */
  setAgeRange(min: number, max: number, step = 1): void {
    this.ageCtrl.min(min).max(max).step(step);
  }

  setVariable(v: VariableInfo, colormap: ColormapData[string]): void {
    // setValue() only repaints the DOM when it differs from the bound state's
    // CURRENT value (lil-gui's own dirty check) -- assigning state.clipMin
    // directly first, then calling setValue() with that same number, makes
    // the two look equal and silently skips both updateDisplay() and
    // onChange. Let setValue() itself own the assignment.
    this.clipMinCtrl.min(v.encode_min).max(v.encode_max).setValue(v.default_clip_min);
    this.clipMaxCtrl.min(v.encode_min).max(v.encode_max).setValue(v.default_clip_max);
    this.clipMinCtrl.name(`clip min (${v.units})`);
    this.clipMaxCtrl.name(`clip max (${v.units})`);
    this.legendLabel.textContent = `${v.name} (${v.units})`;
    this.paintLegend(colormap);
  }

  private paintLegend(cm: ColormapData[string]): void {
    const off = document.createElement('canvas');
    off.width = cm.colors.length;
    off.height = 1;
    const octx = off.getContext('2d')!;
    const img = octx.createImageData(cm.colors.length, 1);
    cm.colors.forEach(([r, g, b], i) => {
      img.data[i * 4] = r; img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
    });
    octx.putImageData(img, 0, 0);

    const ctx = this.legendCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.legendCanvas.width, this.legendCanvas.height);
    ctx.drawImage(off, 0, 0, this.legendCanvas.width, this.legendCanvas.height);
  }

  /** Repaint every controller from the bound state -- needed after a
   *  programmatic change (e.g. the test hook) edits `state` directly rather
   *  than through a slider drag. */
  refreshDisplay(): void {
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }

  setStatus(msg: string): void {
    this.status.textContent = msg;
    this.status.style.display = msg ? 'block' : 'none';
  }

  setTimeInfo(msg: string): void {
    this.timeInfo.textContent = msg;
    this.timeInfo.style.display = msg ? 'block' : 'none';
  }

  dispose(): void {
    this.gui.destroy();
    this.status.remove();
    this.timeInfo.remove();
    this.legend.remove();
  }
}
