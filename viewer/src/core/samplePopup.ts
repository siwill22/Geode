import { plateColors, type PaleomagSampleRecord } from './paleomagPalette';

/**
 * A single, page-global metadata panel for a clicked paleomagnetic Sample
 * Site or VGP -- see reconstruction/reconstructionInstance.ts's
 * `selectSampleAt()`, the click side of this. Deliberately ONE panel fixed
 * to the actual viewport's left edge (not one per Multi-Globe tile, unlike
 * `ClimateUI`'s `positionQueryPanel()`) -- only one sample can be selected
 * across the whole page at a time, and the user's own framing of the
 * request ("a popup window at screen left") was a single, page-fixed spot,
 * not a per-tile one.
 *
 * Chrome mirrors `ClimateUI`'s existing `.query-point-panel` almost exactly
 * (same dark panel, border, close button) but is built with inline styles
 * here rather than a `<style>` block in any one HTML file -- this module is
 * shared by every wrapper that wires up sample-site picking, the same
 * self-contained-styling precedent `core/mapOrientationControl.ts` already
 * set for a cross-wrapper widget.
 */

const panel = document.createElement('div');
Object.assign(panel.style, {
  position: 'fixed',
  display: 'none',
  zIndex: '40',
  left: '12px',
  top: '50%',
  transform: 'translateY(-50%)',
  padding: '8px 12px 10px',
  borderRadius: '4px',
  maxWidth: '260px',
  background: 'rgba(10, 12, 15, 0.95)',
  border: '1px solid #3a4048',
  color: '#cfd6dd',
  fontSize: '11px',
  lineHeight: '1.6',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  pointerEvents: 'auto',
});
document.body.appendChild(panel);

function row(text: string, color?: string): HTMLDivElement {
  const el = document.createElement('div');
  el.textContent = text;
  if (color) el.style.color = color;
  return el;
}

/**
 * Show `record`'s metadata (a VGP/Sample Site's shared underlying record --
 * see `PaleomagSampleRecord`'s own doc comment) and `citation` (the whole
 * pole DATASET's citation; no per-record citation exists). `onDismiss` is
 * called ONLY when the panel's own close button is clicked -- not by
 * `hideSamplePopup()` itself, since a caller closing this for its own
 * reason (e.g. a click landed on neither overlay) has typically already
 * cleared its own highlight state before ever calling that.
 */
export function showSamplePopup(
  record: PaleomagSampleRecord, citation: string, onDismiss: () => void,
): void {
  panel.replaceChildren();

  const close = document.createElement('span');
  Object.assign(close.style, {
    position: 'absolute', top: '4px', right: '7px', cursor: 'pointer',
    color: '#8a929b', fontSize: '12px', lineHeight: '1',
  });
  close.textContent = '✕';
  close.addEventListener('click', () => { onDismiss(); hideSamplePopup(); });
  panel.appendChild(close);

  const title = row(record.name?.trim() || 'Sample site');
  Object.assign(title.style, { fontWeight: '600', paddingRight: '14px' });
  panel.appendChild(title);

  const plateLine = document.createElement('div');
  const swatch = document.createElement('span');
  Object.assign(swatch.style, {
    display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
    background: plateColors(record.plate_id).fill, marginRight: '5px',
  });
  plateLine.appendChild(swatch);
  plateLine.appendChild(document.createTextNode(`Plate ${record.plate_id}`));
  panel.appendChild(plateLine);

  panel.appendChild(row(
    `${record.age.toFixed(1)} Ma${record.a95 != null ? ` · A95 ${record.a95.toFixed(1)}°` : ''}`,
  ));
  panel.appendChild(row(`Pole ${record.lon.toFixed(1)}, ${record.lat.toFixed(1)}`, '#9aa2ab'));
  panel.appendChild(row(`Site ${record.sample_lon.toFixed(1)}, ${record.sample_lat.toFixed(1)}`, '#9aa2ab'));

  const cite = row(citation, '#8a929b');
  cite.style.marginTop = '6px';
  cite.style.fontSize = '10px';
  panel.appendChild(cite);

  panel.style.display = 'block';
}

/** One line of a generic popup: plain text, optionally coloured, optionally
 *  led by a small colour swatch (a legend key for the value). */
export interface PopupLine { text: string; color?: string; swatch?: string }

/**
 * The same page-global panel, for any clicked map object that is not a
 * paleomagnetic sample (a simulated deposit, a place-and-time box, a real
 * deposit): a title and a list of lines, with the same close button and
 * `onDismiss` contract as `showSamplePopup()`.
 */
export function showInfoPopup(title: string, lines: Array<string | PopupLine>, onDismiss: () => void): void {
  panel.replaceChildren();

  const close = document.createElement('span');
  Object.assign(close.style, {
    position: 'absolute', top: '4px', right: '7px', cursor: 'pointer',
    color: '#8a929b', fontSize: '12px', lineHeight: '1',
  });
  close.textContent = '✕';
  close.addEventListener('click', () => { onDismiss(); hideSamplePopup(); });
  panel.appendChild(close);

  const head = row(title);
  Object.assign(head.style, { fontWeight: '600', paddingRight: '14px' });
  panel.appendChild(head);

  for (const l of lines) {
    const line = typeof l === 'string' ? { text: l } : l;
    const el = row('', line.color);
    if (line.swatch) {
      const sw = document.createElement('span');
      Object.assign(sw.style, {
        display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
        background: line.swatch, marginRight: '5px',
      });
      el.appendChild(sw);
    }
    el.appendChild(document.createTextNode(line.text));
    panel.appendChild(el);
  }
  panel.style.display = 'block';
}

export function hideSamplePopup(): void {
  panel.style.display = 'none';
}
