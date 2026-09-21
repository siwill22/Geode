import GUI, { type Controller } from 'lil-gui';
import type { Rect } from '../core/layout';
import { ALL_THEMES, type ResolvedTheme, type ThemeId } from '../core/theme';

/** Substrate first, then the pen, then the accents -- back-to-front, the order
 *  the map itself is built in, so the strip reads as a cross-section of the
 *  view rather than an arbitrary list. */
const ROLE_SWATCH_ORDER = [
  'page', 'water', 'land', 'outline',
  'accentHot', 'accentWarm', 'accentBright', 'accentMuted', 'accentCool',
] as const;

export interface ThemeLabViewState {
  age: number;
  showBoundaries: boolean;
  showLand: boolean;
  showOcean: boolean;
  showEdges: boolean;
  themeId: ThemeId;
}

export interface ThemeLabUICallbacks {
  onAge(age: number): void;
  onShowBoundaries(show: boolean): void;
  onShowLand(show: boolean): void;
  onShowOcean(show: boolean): void;
  onShowEdges(show: boolean): void;
  onTheme(id: ThemeId): void;
}

/**
 * The theme lab's per-globe panel: a Theme picker first, then the little else
 * this wrapper has.
 *
 * Theme sits at the top because it is the subject, not a display preference --
 * the inverse of where it would belong in a viewer that is actually showing
 * data.
 */
export class ThemeLabUI {
  readonly gui: GUI;
  private ageCtrl: Controller;
  private boundariesCtrl: Controller | null = null;
  private status: HTMLDivElement;
  private timeInfo: HTMLDivElement;
  private credit: HTMLDivElement;
  /** The swatch strip + description under the panel: what the Theme actually
   *  IS, shown rather than described, so a comparison does not depend on
   *  remembering which name meant which palette. */
  private themeCard: HTMLDivElement;
  private panelAnchor: HTMLDivElement;
  private rect: Rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };

  constructor(
    private state: ThemeLabViewState,
    private cb: ThemeLabUICallbacks,
    title: string,
    onRemove?: () => void,
  ) {
    this.panelAnchor = document.createElement('div');
    Object.assign(this.panelAnchor.style, { position: 'fixed', zIndex: '10' });
    document.body.appendChild(this.panelAnchor);
    this.gui = new GUI({ title, container: this.panelAnchor });

    const names: Record<string, ThemeId> = {};
    for (const t of ALL_THEMES) {
      names[`${t.name}  (${t.lightness}/${t.temperature})`] = t.id;
    }
    this.gui.add(this.state, 'themeId', names)
      .name('Theme')
      .onChange((v: ThemeId) => cb.onTheme(v));

    this.ageCtrl = this.gui.add(this.state, 'age', 0, 1, 1)
      .name('Reconstruction Age')
      .onChange((v: number) => cb.onAge(v));

    this.gui.add(this.state, 'showOcean')
      .name('Show ocean')
      .onChange((v: boolean) => cb.onShowOcean(v));

    this.gui.add(this.state, 'showLand')
      .name('Show land fill')
      .onChange((v: boolean) => cb.onShowLand(v));

    // Independent of the Theme's own Outline Treatment: a 'shade' or
    // 'contrast' Theme can have its edges switched off here, and a 'none'
    // Theme stays penless whatever this says (see Coastlines.penVisible).
    this.gui.add(this.state, 'showEdges')
      .name('Show continent edges')
      .onChange((v: boolean) => cb.onShowEdges(v));

    this.themeCard = document.createElement('div');
    this.themeCard.className = 'theme-card';
    this.panelAnchor.appendChild(this.themeCard);

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

    if (onRemove) {
      this.gui.add({ remove: onRemove }, 'remove').name('remove this globe');
    }
    this.applyRect();
  }

  /** Paint the swatch strip for a resolved Theme. The OUTLINE swatch shows the
   *  resolved pen, not `roles.outline` -- for a `shade` Theme those differ, and
   *  showing the authored role would misreport what is on the globe. */
  setThemeInfo(theme: ResolvedTheme): void {
    const t = theme.theme;

    // Chrome drawn straight onto the map -- the credit line especially, which
    // has no background of its own -- has to follow THIS instance's Lightness.
    // Per-element rather than the page-level flag core/theme.ts exposes,
    // because in this one wrapper each tile has its own Theme, so there is no
    // single page Lightness to stamp. This is Lightness doing its real job:
    // the credit was grey-on-tan and unreadable on every light Theme, and no
    // amount of choosing a better grey fixes a mark that needs to invert.
    for (const el of [this.status, this.timeInfo, this.credit]) {
      el.dataset.lightness = t.lightness;
    }
    const pen = theme.outline === null
      ? null
      : `#${theme.outline.toString(16).padStart(6, '0')}`;

    const swatches = ROLE_SWATCH_ORDER.map((role) => {
      // No cast needed: every member of ROLE_SWATCH_ORDER is a string-valued
      // key of ThemeRoles, so this narrows to `string`. The ramp roles are
      // deliberately absent from the strip -- they are pairs, not swatches.
      const colour = role === 'outline' ? pen : t.roles[role];
      if (colour === null) {
        return '<span class="sw sw-none" title="outline: none — no pen drawn">/</span>';
      }
      return `<span class="sw" style="background:${colour}" title="${role} ${colour}"></span>`;
    }).join('');

    this.themeCard.innerHTML = `
      <div class="sw-row">${swatches}</div>
      <div class="theme-meta">
        <b>${t.name}</b> &middot; ${t.lightness}/${t.temperature}
        &middot; weight ${t.weight} &middot; outline ${t.outline}
      </div>
      <div class="theme-desc">${t.description}</div>`;
  }

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
