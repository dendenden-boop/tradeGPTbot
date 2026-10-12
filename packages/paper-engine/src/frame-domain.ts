import type { DurableMarketSnapshots, DurableMarketTrades, MarketTradeKey } from '@ctp/market-data';
import type {
  PaperConfigurationReceipt,
  PaperConfigurationStore,
  PaperOwner,
  PaperConfigurationIo,
} from './configuration-domain.js';
import type { PaperFrame } from './model.js';

export interface PaperMarketFrameRequest {
  readonly owner: PaperOwner;
  readonly key: MarketTradeKey;
}
/** Calculation input only. Independent reads are not an atomic Risk certificate,
 * durable liquidity allocation, reservation, grant or virtual dispatch permit. */
export interface PaperMarketFrameCapture {
  readonly configuration: PaperConfigurationReceipt;
  readonly frame: PaperFrame;
  readonly capturedAt: number;
  readonly expiresAt: number;
  readonly evidence: {
    readonly snapshotId: string;
    readonly snapshotRevision: string;
    readonly snapshotHash: string;
    readonly tradeId: string;
    readonly tradeRevision: string;
    readonly tradeHash: string;
  };
}
export interface PaperMarketFrames {
  capture(
    request: PaperMarketFrameRequest,
    io: PaperConfigurationIo,
  ): Promise<Readonly<PaperMarketFrameCapture>>;
  close(): Promise<void>;
}
/** Internal source-test seam. The public factory creates all actual PostgreSQL
 * ports itself and exports neither this interface nor an injectable reader. */
export interface FrameReadPorts {
  readonly configuration: Pick<PaperConfigurationStore, 'read' | 'close'>;
  readonly snapshots: Pick<DurableMarketSnapshots, 'read' | 'close'>;
  readonly trades: Pick<DurableMarketTrades, 'read' | 'close'>;
  readonly now?: () => number;
}
