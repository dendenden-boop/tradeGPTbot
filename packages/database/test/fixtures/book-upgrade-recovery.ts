/** Test-only populated-upgrade evidence. Never a runtime retry/authority port. */
type Stage = 'INITIALIZE' | 'REPLAY' | 'READ';
export interface BookUpgradeEvidence {
  readonly stage: Stage;
  readonly outcome:
    'STARTED' | 'ACKNOWLEDGED' | 'FAILED' | 'UNCERTAIN' | 'RECOVERED_READ_ONLY' | 'UNRESOLVED';
}
export async function bookUpgradeFixtureOperation<Owner, Io, Receipt>(options: {
  stage: Stage;
  port: {
    initialize(owner: Owner, io: Io): Promise<Receipt>;
    read(owner: Owner, io: Io): Promise<Receipt>;
  };
  owner: Owner;
  io(): Io;
  verify(receipt: Receipt): void | Promise<void>;
  record(event: BookUpgradeEvidence): void;
}): Promise<Receipt> {
  const { stage } = options;
  if (!['INITIALIZE', 'REPLAY', 'READ'].includes(stage)) throw Error('BOOK_UPGRADE_STAGE');
  options.record({ stage, outcome: 'STARTED' });
  // Only an error from the actual native operation can mean uncertain COMMIT.
  // IO/validation/recording failures must never trigger another operation.
  const context = options.io();
  let result: Receipt;
  try {
    result = await (stage === 'READ'
      ? options.port.read(options.owner, context)
      : options.port.initialize(options.owner, context));
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'PAPER_BOOK_UNCERTAIN') {
      options.record({ stage, outcome: 'FAILED' });
      throw error;
    }
    options.record({ stage, outcome: 'UNCERTAIN' });
    try {
      // Exactly one readonly recapture. Production read opens a fresh bounded
      // transaction/socket. Never repeat initialize after an uncertain result.
      result = await options.port.read(options.owner, options.io());
      await options.verify(result);
    } catch (unresolved) {
      options.record({ stage, outcome: 'UNRESOLVED' });
      throw unresolved;
    }
    options.record({ stage, outcome: 'RECOVERED_READ_ONLY' });
    return result;
  }
  await options.verify(result);
  options.record({ stage, outcome: 'ACKNOWLEDGED' });
  return result;
}
