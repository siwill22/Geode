import GUI, { type Controller } from 'lil-gui';
import type { Rect } from '../core/layout';

export interface ReconstructionViewState {
  age: number;
  showBoundaries: boolean;
}

export interface ReconstructionUICallbacks {
  onAge(age: number): void;
  onShowBoundaries(show: boolean): void;
}

/**
 * The `single-reconstruction-globe` panel: a Reconstruction Age slider,
 * plus -- only when the loaded Reconstruction Model actually has Boundary
 * Frames (see docs/adr/0019, some models never will) -- a visibility
 * toggle for them. No Variable, no legend, no clip range, no query-point:
 * this wrapper never paints a numerical field, on principle, not as a
 * temporary gap (see docs/adr/0020).
 */
export class ReconstructionUI {
  readonly gui: GUI;
  private ageCtrl: Controller;
  private boundariesCtrl: Controller | null = null;
  private status: HTMLDivElement;
  private timeInfo: HTMLDivElement;
  private credit: HTMLDivElement;
  /** Positioned per-instance by setRect(); anchors the panel's top-right
   *  corner -- see globe/globeUi.ts's identical panelAnchor. */
  private panelAnchor: HTMLDivElement;
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };

  constructor(
    private state: ReconstructionViewState,
    private cb: ReconstructionUICallbacks,
    title: string,
    onRemove?: () => void,
  ) {
    this.panelAnchor = document.createElement('div');
    Object.assign(this.panelAnchor.style, { position: 'fixed', zIndex: '10' });
    document.body.appendChild(this.panelAnchor);
    this.gui = new GUI({ title, container: this.panelAnchor });
    this.ageCtrl = this.gui.add(this.state, 'age', 0, 1, 1)
      .name('Reconstruction Age')
      .onChange((v: number) => cb.onAge(v));

    // top: 48/84, not 12/44 -- clears the page-level #globe-menu-toggle icon
    // fixed at the screen's actual top-left corner (core/multiGlobeMenu.css),
    // which for the top-left tile is the same screen position these would
    // otherwise sit at.
    this.status = document.createElement('div');
    this.status.className = 'status';
    Object.assign(this.status.style, { top: '48px', left: '12px' });
    document.body.appendChild(this.status);
    this.setStatus('');

    this.timeInfo = document.createElement('div');
    this.timeInfo.className = 'timeinfo';
    Object.assign(this.timeInfo.style, { top: '84px', left: '12px' });
    document.body.appendChild(this.timeInfo);
    this.setTimeInfo('');

    this.credit = document.createElement('div');
    this.credit.className = 'credit';
    Object.assign(this.credit.style, { bottom: '8px', right: '12px' });
    document.body.appendChild(this.credit);

    if (onRemove) {
      this.gui.add({ remove: onRemove }, 'remove').name('remove this globe');
    }
  }

  /** Move this instance's panel/status/timeInfo/credit onto a new tile --
   *  see core/multiInstanceHost.ts, docs/adr/0022. */
  setRect(rect: Rect): void {
    this.rect = rect;
    this.applyRect();
  }

  private applyRect(): void {
    const { x, y, width, height } = this.rect;
    const rightEdge = innerWidth - (x + width);
    const bottomEdge = innerHeight - (y + height);
    this.panelAnchor.style.top = `${y + 8}px`;
    this.panelAnchor.style.right = `${rightEdge + 8}px`;
    this.status.style.top = `${y + 48}px`;
    this.status.style.left = `${x + 12}px`;
    this.timeInfo.style.top = `${y + 80}px`;
    this.timeInfo.style.left = `${x + 12}px`;
    this.credit.style.bottom = `${bottomEdge + 8}px`;
    this.credit.style.right = `${rightEdge + 12}px`;
  }

  setAgeRange(min: number, max: number, step = 1): void {
    this.ageCtrl.min(min).max(max).step(step);
  }

  /** Added/removed rather than shown/hidden: whether this control exists
   *  at all depends on the loaded Reconstruction Model, which for
   *  `reconstruction-group-globe` can change at runtime (see that
   *  wrapper's identical method). */
  setBoundariesAvailable(available: boolean): void {
    if (available && !this.boundariesCtrl) {
      this.boundariesCtrl = this.gui.add(this.state, 'showBoundaries')
        .name('Show boundaries')
        .onChange((v: boolean) => this.cb.onShowBoundaries(v));
    } else if (!available && this.boundariesCtrl) {
      this.boundariesCtrl.destroy();
      this.boundariesCtrl = null;
    }
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
    this.panelAnchor.remove();
    this.status.remove();
    this.timeInfo.remove();
    this.credit.remove();
  }
}
