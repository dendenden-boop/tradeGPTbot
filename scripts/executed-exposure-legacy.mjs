// Test-only exact accepted e078554 calculator root reconstruction.
import { createHash } from 'node:crypto';
export const executedExposureAddition = `
export {
  calculatePaperExecutedExposure,
  type PaperExecutedExposureCalculation,
} from './executed-exposure.js';
`;
export const beforeExecutedExposureHash =
  '13780a2509169222ad729ae7595e2a936556f96fa51a05547294372ea2044b59';
export function beforeExecutedExposureRoot(text) {
  if (typeof text !== 'string' || !text.endsWith(executedExposureAddition))
    throw Error('PAPER_EXECUTED_EXPOSURE_ROOT_REVIEW');
  const retained = text.slice(0, -executedExposureAddition.length);
  if (createHash('sha256').update(retained).digest('hex') !== beforeExecutedExposureHash)
    throw Error('PAPER_EXECUTED_EXPOSURE_ROOT_REVIEW');
  return retained;
}
