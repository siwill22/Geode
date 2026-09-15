import GUI, { type Controller } from 'lil-gui';

export interface OldMapViewState {
  age: number;
  showWash: boolean;
  showRings: boolean;
  showMountains: boolean;
  showTrenches: boolean;
}

export type OldMapToggle = 'showWash' | 'showRings' | 'showMountains' | 'showTrenches';

export interface OldMapUICallbacks {
  onAge(age: number): void;
  onToggle(key: OldMapToggle, on: boolean): void;
}

/**
 * One Reconstruction Age slider and three visibility toggles -- no Variable, no
 * legend, no query point. This wrapper never paints a numerical field
 * (docs/adr/0020), and the three toggles exist so the style elements can be
 * looked at one at a time while their pixel widths are being tuned, which
 * ADR-0037 makes the main way this viewer is adjusted.
 */
export class OldMapUI {
  readonly gui: GUI;
  private ageCtrl: Controller;
  private status: HTMLDivElement;
  private timeInfo: HTMLDivElement;
  private credit: HTMLDivElement;

  constructor(
    private state: OldMapViewState,
    cb: OldMapUICallbacks,
    title: string,
  ) {
    this.gui = new GUI({ title });
    this.ageCtrl = this.gui.add(this.state, 'age', 0, 200, 1)
      .name('Reconstruction Age')
      .onChange((v: number) => cb.onAge(v));
    this.gui.add(this.state, 'showWash').name('Coastal wash')
      .onChange((v: boolean) => cb.onToggle('showWash', v));
    this.gui.add(this.state, 'showRings').name('Offshore rings')
      .onChange((v: boolean) => cb.onToggle('showRings', v));
    this.gui.add(this.state, 'showMountains').name('Mountains')
      .onChange((v: boolean) => cb.onToggle('showMountains', v));
    // Debug: the mountain rule's second criterion is "<800 km from a subduction
    // zone", and without the trenches on screen there is no way to see whether a
    // glyph is where the rule says it should be.
    this.gui.add(this.state, 'showTrenches').name('Subduction zones (debug)')
      .onChange((v: boolean) => cb.onToggle('showTrenches', v));

    this.status = document.createElement('div');
    this.status.className = 'status';
    document.body.appendChild(this.status);
    this.setStatus('');

    this.timeInfo = document.createElement('div');
    this.timeInfo.className = 'timeinfo';
    document.body.appendChild(this.timeInfo);
    this.setTimeInfo('');

    this.credit = document.createElement('div');
    this.credit.className = 'credit';
    document.body.appendChild(this.credit);
  }

  setAgeRange(min: number, max: number, step = 1): void {
    this.ageCtrl.min(min).max(max).step(step);
  }

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

  setCredit(text: string): void {
    this.credit.textContent = text;
  }

  dispose(): void {
    this.gui.destroy();
    this.status.remove();
    this.timeInfo.remove();
    this.credit.remove();
  }
}
