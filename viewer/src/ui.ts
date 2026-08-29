import GUI from 'lil-gui';
import type { ArchiveIndex, Manifest, VariableInfo } from './types';

export type ToolMode = 'drag' | 'draw' | 'edit';

/**
 * What the globe's surface shows.
 *   topography - GEBCO relief. Present-day only; meaningless at age > 0.
 *   land       - reconstructed land polygons filled, correct at any age.
 *   flat       - plain ocean colour.
 */
export type SurfaceMode = 'topography' | 'land' | 'flat';

export interface ViewState {
  modelId: string;
  variableId: string;
  colormap: string;
  clipMin: number;
  clipMax: number;
  symmetricClip: boolean;
  reconstructionAge: number;
  cutDepthKm: number;
  inverted: boolean;
  surfaceOpacity: number;
  surfaceMode: SurfaceMode;
  tool: ToolMode;
}

export interface UICallbacks {
  onModel(id: string): void;
  onVariable(id: string): void;
  onColormap(name: string): void;
  onClip(): void;
  onAge(age: number): void;
  onCutDepth(km: number): void;
  onInvert(): void;
  onSurfaceOpacity(v: number): void;
  onSurfaceMode(m: SurfaceMode): void;
  onTool(t: ToolMode): void;
  onClear(): void;
  onExportPNG(): void;
  onExportPolygon(): void;
  onImportPolygon(): void;
}

export class UI {
  readonly gui: GUI;
  private clipMinCtrl!: any;
  private clipMaxCtrl!: any;
  private variableCtrl!: any;
  private folderData: GUI;
  private surfaceModeCtrl!: any;
  private status: HTMLDivElement;

  constructor(
    private state: ViewState,
    archive: ArchiveIndex,
    colormapNames: string[],
    private cb: UICallbacks,
  ) {
    this.gui = new GUI({ title: 'Geode' });

    const models: Record<string, string> = {};
    for (const m of archive.models) models[m.name] = m.id;

    this.folderData = this.gui.addFolder('Model');
    this.folderData
      .add(this.state, 'modelId', models)
      .name('model')
      .onChange((v: string) => cb.onModel(v));
    this.variableCtrl = this.folderData
      .add(this.state, 'variableId', { '-': '-' })
      .name('variable')
      .onChange((v: string) => cb.onVariable(v));

    const fc = this.gui.addFolder('Colour');
    fc.add(this.state, 'colormap', colormapNames)
      .name('colormap')
      .onChange((v: string) => cb.onColormap(v));
    this.clipMinCtrl = fc
      .add(this.state, 'clipMin', -10, 0, 0.01)
      .name('clip min')
      .onChange(() => this.handleClip('min'));
    this.clipMaxCtrl = fc
      .add(this.state, 'clipMax', 0, 10, 0.01)
      .name('clip max')
      .onChange(() => this.handleClip('max'));
    fc.add(this.state, 'symmetricClip')
      .name('symmetric')
      .onChange(() => this.handleClip('min'));

    const ft = this.gui.addFolder('Time');
    ft.add(this.state, 'reconstructionAge', archive.coastlines.age_min,
      archive.coastlines.age_max, 0.5)
      .name('age (Ma)')
      .onChange((v: number) => cb.onAge(v));

    const fx = this.gui.addFolder('Cutaway');
    fx.add(this.state, 'tool', { 'Drag Globe': 'drag', 'Draw Polygon': 'draw', 'Edit Vertices': 'edit' })
      .name('tool')
      .onChange((v: ToolMode) => cb.onTool(v));
    fx.add(this.state, 'cutDepthKm', 100, 2890, 10)
      .name('cut depth (km)')
      .onChange((v: number) => cb.onCutDepth(v));
    fx.add(this.state, 'inverted')
      .name('invert')
      .onChange(() => cb.onInvert());
    fx.add({ clear: () => cb.onClear() }, 'clear').name('clear polygon');

    const fs = this.gui.addFolder('Scene');
    this.surfaceModeCtrl = fs
      .add(this.state, 'surfaceMode',
        { Topography: 'topography', 'Land fill': 'land', Flat: 'flat' })
      .name('surface')
      .onChange((v: SurfaceMode) => cb.onSurfaceMode(v));
    fs.add(this.state, 'surfaceOpacity', 0, 1, 0.01)
      .name('surface opacity')
      .onChange((v: number) => cb.onSurfaceOpacity(v));

    const fe = this.gui.addFolder('Export');
    fe.add({ png: () => cb.onExportPNG() }, 'png').name('PNG screenshot');
    fe.add({ p: () => cb.onExportPolygon() }, 'p').name('polygon -> GeoJSON');
    fe.add({ i: () => cb.onImportPolygon() }, 'i').name('load polygon');
    fe.close();

    this.status = document.createElement('div');
    this.status.id = 'status';
    document.body.appendChild(this.status);
    this.setStatus('');
  }

  private handleClip(driver: 'min' | 'max'): void {
    if (this.state.symmetricClip) {
      const m = driver === 'min'
        ? Math.abs(this.state.clipMin)
        : Math.abs(this.state.clipMax);
      this.state.clipMin = -m;
      this.state.clipMax = m;
      this.clipMinCtrl.updateDisplay();
      this.clipMaxCtrl.updateDisplay();
    }
    this.cb.onClip();
  }

  /** Re-point the variable dropdown and clip sliders when the model changes. */
  setModel(manifest: Manifest, variable: VariableInfo): void {
    const opts: Record<string, string> = {};
    for (const v of manifest.variables) opts[v.name] = v.id;
    this.variableCtrl = this.variableCtrl.options(opts).onChange(
      (v: string) => this.cb.onVariable(v),
    );
    this.variableCtrl.setValue(variable.id);
    this.setVariable(variable);
  }

  /** Clip sliders are bounded by the encode range: outside it the data is clamped. */
  setVariable(v: VariableInfo): void {
    this.state.clipMin = v.default_clip_min;
    this.state.clipMax = v.default_clip_max;
    this.clipMinCtrl.min(v.encode_min).max(0).setValue(v.default_clip_min);
    this.clipMaxCtrl.min(0).max(v.encode_max).setValue(v.default_clip_max);
    this.clipMinCtrl.name(`clip min (${v.units})`);
    this.clipMaxCtrl.name(`clip max (${v.units})`);
  }

  setSurfaceMode(m: SurfaceMode): void {
    this.state.surfaceMode = m;
    this.surfaceModeCtrl.updateDisplay();
  }

  setStatus(msg: string): void {
    this.status.textContent = msg;
    this.status.style.display = msg ? 'block' : 'none';
  }
}
