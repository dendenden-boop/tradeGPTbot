import type { InstrumentRegistry, MarketScope, TradeTick } from '@ctp/exchange-core';
import type { Bar, CandleState, CoverageProof } from './candles.js';

export interface IoContext {
  readonly signal: AbortSignal;
  readonly deadline: number;
}
export interface StoredPartition {
  readonly epoch: string;
  readonly version: number;
  readonly state: CandleState;
}
export interface MarketEvent {
  readonly id: string;
  readonly key: string;
  readonly type: 'CANDLE_CLOSED' | 'CANDLE_REVISED' | 'MARKET_GAP';
  readonly bar: Bar | null;
  readonly reason: string | null;
}
/** Atomic state/checkpoint + candle revisions + outbox; epochs survive process restart. */
export interface MarketStore {
  acquire(
    key: string,
    owner: string,
    initial: CandleState,
    context: IoContext,
  ): Promise<StoredPartition>;
  commit(
    key: string,
    owner: string,
    previous: StoredPartition,
    state: CandleState,
    events: readonly MarketEvent[],
    context: IoContext,
  ): Promise<StoredPartition>;
  events(key: string, limit: number, context: IoContext): Promise<readonly MarketEvent[]>;
  acknowledge(key: string, ids: readonly string[], context: IoContext): Promise<void>;
  release(key: string, owner: string, epoch: string, context: IoContext): Promise<void>;
  close(): Promise<void>;
}
export type FeedInput =
  | {
      readonly kind: 'TRADE';
      readonly tick: TradeTick;
      readonly metadataVersion: string;
      readonly executionCount: number | null;
    }
  | { readonly kind: 'COVERAGE'; readonly proof: CoverageProof; readonly repaired: boolean }
  | { readonly kind: 'GAP'; readonly from: number; readonly to: number; readonly reason: string };
export interface FeedIntent {
  readonly scope: MarketScope;
  readonly instrumentId: string;
  readonly profileId: string;
}
export interface FeedConnection {
  close(): Promise<void>;
}
/** Public-only server port. open must settle after abort, including hung ACK/handshake. */
export interface PublicFeedPort {
  readonly maxTopics: number;
  readonly maxConnections: number;
  open(
    intents: readonly FeedIntent[],
    context: IoContext,
    onInput: (key: string, input: FeedInput) => void,
    onGap: (reason: string) => void,
  ): Promise<FeedConnection>;
}
/** Shared server/IP coordinator, not a per-worker token bucket. */
export interface PublicRatePort {
  reserve(
    profileId: string,
    kind: 'CONNECTION' | 'CONTROL',
    count: number,
    context: IoContext,
  ): Promise<boolean>;
}
export interface EngineOptions {
  readonly registry: InstrumentRegistry;
  readonly store: MarketStore;
  readonly now?: () => number;
  readonly maxInstruments?: number;
  readonly maxQueue?: number;
  readonly maxQueueBytes?: number;
  readonly maxStateBytes?: number;
  readonly staleAfterMs?: number;
}
