/**
 * Web Worker shell around core/shSynthesis.ts computeField. Models are
 * registered once (their coefficient arrays are copied in); each synth
 * request returns a Float32Array, transferred, not copied.
 *
 * Protocol (see core/shSynthesisClient.ts):
 *   in:  { type: 'register', id, coeffs }  |  { type: 'main', id }
 *        { type: 'synth', reqId, spec }
 *   out: { type: 'done', reqId, result }   |  { type: 'error', reqId, message }
 */
import { computeField, type FieldSpec, type ModelLookup, type ShCoeffs } from './shSynthesis';

const store = new Map<string, ShCoeffs>();
const models: ModelLookup = { get: (id) => store.get(id), mainFieldId: '' };

type Msg =
  | { type: 'register'; id: string; coeffs: ShCoeffs }
  | { type: 'main'; id: string }
  | { type: 'synth'; reqId: number; spec: FieldSpec };

self.onmessage = (ev: MessageEvent<Msg>) => {
  const msg = ev.data;
  if (msg.type === 'register') {
    store.set(msg.id, msg.coeffs);
  } else if (msg.type === 'main') {
    models.mainFieldId = msg.id;
  } else if (msg.type === 'synth') {
    try {
      const result = computeField(msg.spec, models);
      (self as unknown as Worker).postMessage(
        { type: 'done', reqId: msg.reqId, result },
        [result.values.buffer],
      );
    } catch (err) {
      (self as unknown as Worker).postMessage({
        type: 'error', reqId: msg.reqId, message: err instanceof Error ? err.message : String(err),
      });
    }
  }
};
