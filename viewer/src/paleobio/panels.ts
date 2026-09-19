/**
 * Typed shims for petrify's two DOM panel modules.
 *
 * Both are plain JavaScript with destructured, `null`-defaulted options
 * (`onSeek = null, onRender = null, ...`), so TypeScript infers those
 * parameters as literally `null` and rejects every real callback. The library
 * is vendored JS by design -- it has no build step and no `.d.ts` -- so the
 * types belong on this side of the boundary.
 *
 * Deliberately hand-written rather than `any`: these are the only two places
 * the wrapper talks to an untyped module, and writing the contract down here
 * means a change upstream shows up as a compile error in one file instead of
 * a runtime surprise spread across the instance.
 */
import { attachLatitudePanel as attachLatitudePanelJs } from '../../vendor/petrify/js/latitude-panel.js';
import { attachTimeSeries as attachTimeSeriesJs } from '../../vendor/petrify/js/timeseries-panel.js';

/**
 * Which end of a panel's age axis the present sits at.
 *
 * Geode is 'present-left' everywhere -- `core/timeSeriesPanel.ts` maps
 * `(age - ageMin) / span`, and every lil-gui age slider runs its minimum on the
 * left. petrify defaults to 'oldest-left' instead, so BOTH panels are set
 * explicitly rather than one being left on its default: two charts stacked on
 * what reads as one shared axis must not run opposite ways.
 */
export type TimeDirection = 'oldest-left' | 'present-left';

export interface LatitudePanelOptions {
  element: HTMLElement;
  url?: string;
  data?: unknown;
  range: [number, number];
  grouping?: string;
  onSeek?: (age: number) => void;
  onRender?: () => void;
  height?: number;
  mode?: 'dominant' | 'density';
  timeDirection?: TimeDirection;
}

export interface LatitudePanelHandle {
  setGrouping(name: string): LatitudePanelHandle;
  setTimeDirection(d: TimeDirection): LatitudePanelHandle;
  setMode(mode: 'dominant' | 'density'): LatitudePanelHandle;
  setTime(age: number): LatitudePanelHandle;
  resize(): boolean;
  draw(): void;
  destroy(): void;
}

export interface TimeSeriesSource {
  url: string;
  series: Record<string, { label?: string; unit?: string; colour?: string; visible?: boolean }>;
}

export interface TimeSeriesOptions {
  element: HTMLElement;
  sources: TimeSeriesSource[];
  range: [number, number];
  onSeek?: (age: number) => void;
  onRender?: () => void;
  mode?: string;
  timeDirection?: TimeDirection;
}

export interface TimeSeriesHandle {
  setTime(age: number): TimeSeriesHandle;
  setMode(mode: string): void;
  resize(): boolean;
  draw(): void;
  clipping(): boolean;
  destroy(): void;
}

export const attachLatitudePanel =
  attachLatitudePanelJs as unknown as (o: LatitudePanelOptions) => Promise<LatitudePanelHandle>;

export const attachTimeSeries =
  attachTimeSeriesJs as unknown as (o: TimeSeriesOptions) => Promise<TimeSeriesHandle>;
