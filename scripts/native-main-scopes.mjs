// Reviewed test-only database scopes at 09d13d6. These files may mutate their
// own database, but not cluster roles. Unknown files remain behind the mutator barrier.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { workspace } from './docker-test-utils.mjs';
export const scopedMainFiles = Object.freeze([
  'packages/auth/test/rate-limit-hardening.integration.test.ts',
  'packages/auth/test/rate-limit.integration.test.ts',
  'packages/database/test/audit.integration.test.ts',
  'packages/database/test/decimal-boundary.integration.test.ts',
  'packages/database/test/ledger.integration.test.ts',
  'packages/database/test/market-data.integration.test.ts',
  'packages/database/test/market-trades.integration.test.ts',
  'packages/database/test/order-fixture-clock.integration.test.ts',
  'packages/database/test/order-lock-order.integration.test.ts',
  'packages/database/test/paper-execution-effects.integration.test.ts',
  'packages/database/test/paper-execution-math.integration.test.ts',
  'packages/database/test/paper-market-frames.integration.test.ts',
  'packages/database/test/paper-reservation-state.integration.test.ts',
  'packages/database/test/paper-reservation-storage.integration.test.ts',
  'packages/database/test/paper-risk-evaluation.integration.test.ts',
  'packages/database/test/paper-runtime.integration.test.ts',
  'packages/database/test/portfolio.integration.test.ts',
  'packages/database/test/query-plans.integration.test.ts',
  'packages/database/test/risk-admission-prerequisite.integration.test.ts',
  'packages/database/test/risk-certification-prerequisite.integration.test.ts',
  'packages/database/test/risk-certification.integration.test.ts',
  'packages/database/test/risk-controls.integration.test.ts',
]);
export const scopedMainSources = Object.freeze({
  'packages/auth/test/rate-limit-hardening.integration.test.ts':
    'e6174bfbc01f11a4465c212d15017f4781981c91e2a5ba7864ea88aa58eca64a',
  'packages/auth/test/rate-limit.integration.test.ts':
    '809f5711fe855b4cf62ca84ba99be23fbda7eed10a8e20f1b369db6fbb390c36',
  'packages/database/test/audit.integration.test.ts':
    'b05b9d9166fd0bd11cb48071d7a04dbeee86ffedc4bcc2cc3ad59aaca4cee23b',
  'packages/database/test/decimal-boundary.integration.test.ts':
    '5df214ff4e1b33f31c8ba6035d444af49f6d9bec798ced46d09782f738719b75',
  'packages/database/test/fixtures/paper-reservation.ts':
    'e20cc21e5fbe220221b7fb2da302525bcd80cbc7aaa937cf46d943cc8e8823e3',
  'packages/database/test/fixtures/registry-commit-proxy.ts':
    'a64aefc8526cea37cc6f218c407ee730d82e58f504d8a111888d03ca0a915af4',
  'packages/database/test/fixtures/risk-certification.ts':
    '6b73c812085a6e1230fa0bc01a34c1525b0ed42c5832c5908056d35e5922f54c',
  'packages/database/test/ledger.integration.test.ts':
    'bab8183ce7bc359fcde2a692ff809e572b21753b42e3802df589f0dbeb52a2eb',
  'packages/database/test/market-data.integration.test.ts':
    '971bebfd55970fbdb3b9a041bd286287035e5e4c6a633663d7d007d05affc5cc',
  'packages/database/test/market-trades.integration.test.ts':
    '2488efa619605da702a98c276c94c79a16bc46e8cc601957add0c58e2cc03a71',
  'packages/database/test/order-fixture-clock.integration.test.ts':
    'aa0e5a43c59ec4cc76930e16c0edfb320aa503bb1143d485543b8b0399333b20',
  'packages/database/test/order-lock-order.integration.test.ts':
    'effa4087c7b56c85128217c55727f2e90b632d061ceb55351166db7bf2ab42ad',
  'packages/database/test/paper-execution-effects.integration.test.ts':
    '549bf60eb2bfd777415b93ac13d0bf65a68a93f978cb0fa11ca462618a2bbc02',
  'packages/database/test/paper-execution-math.integration.test.ts':
    'b9301dd28c0e0a01cd5be7cf288dddebdd894aae48f573234ec57aea3e53cdb8',
  'packages/database/test/paper-market-frames.integration.test.ts':
    '03755e712ebf2a76aeee6da9e77999a9ffbaffc21372c83d5bd91ba17af4a738',
  'packages/database/test/paper-reservation-state.integration.test.ts':
    'fab37e14a353a33cad33317fc2a4efe6b64e2366ecf1c9a2001c71f3fc7ef8be',
  'packages/database/test/paper-reservation-storage.integration.test.ts':
    '48f22a559e2eb2ef3b31ea604bf3fafe041a393a31b575103a8265783536e01b',
  'packages/database/test/paper-risk-evaluation.integration.test.ts':
    '0d97efc59df89399dd6e45d0634942693a5d8b26dd669404d128764758a1899b',
  'packages/database/test/paper-runtime.integration.test.ts':
    '3007b747a9744bd01d786c1b0fede2a0d54afaf7ff0d15890b63cbdc095f3cf5',
  'packages/database/test/portfolio.integration.test.ts':
    '3418e7b01cf921d3e44a2cea9403a80cf52566bea231762899ceeaf6fb795fbd',
  'packages/database/test/query-plans.integration.test.ts':
    '05ea13a3ecc7ba93f4abee16e0646e7faf5f33b779b6fc6e3a77d74f65f64859',
  'packages/database/test/risk-admission-prerequisite.integration.test.ts':
    '37e84de18705891e295ca45065e69787d5b494e978d2d70a54d353080d0d8978',
  'packages/database/test/risk-certification-prerequisite.integration.test.ts':
    '0dd45936a6c1097f2509e5cc847c098260711f75dde5e5479c3c886d71320c0d',
  'packages/database/test/risk-certification.integration.test.ts':
    '1dd548e50e10745b7b353b3ac0b30fa24c4dfe129f157b1651e629ac66793d74',
  'packages/database/test/risk-controls.integration.test.ts':
    'c7b2c50ed76bd1b85a8de42537501869c98c20b72a3490f0c5b761f6793fbb06',
  'packages/exchange-core/test/fixtures/adapter.ts':
    '4183fa89da2f2b240aaf0d634fa5bc50c50b99bd774e9ff8f213fa37f66b7ec4',
  'packages/exchange-core/test/fixtures/domain.ts':
    '2579b6b490d8e6c793b1efcc60e19a0b68089b4c7858ebf97f735e07b5daf23a',
  'packages/market-data/test/fixtures.ts':
    'feaf4101e4b6f46c24f436cbdd707285fb0d791bf1fcf4ca1c1c7c2f84b2fa93',
  'packages/market-data/test/snapshot-fixture.ts':
    '067ac3d17e3e80c4240c6bd2fb7856835f9affb10d2b5fad56c2280a14d5eff1',
  'packages/market-data/test/trade-fixture.ts':
    '7e1a9e33613e18b3ce472583d86fe0dfae968c1c17724678bb56689ee61a1fcd',
  'packages/order-engine/test/fixtures.ts':
    '28990b2e46d9c1b7fc462187dd1687cf8401e432c3214aaa0972b10e4b4ad717',
  'packages/paper-engine/test/admission-wire-fixtures.ts':
    '8c261b31651317b0ffda7e2295abb3121a6da989e1711a3da53784f3b576b1e3',
  'packages/paper-engine/test/execution-source-fixtures.ts':
    'cd1be17e1de341af2810acfdf6a5b8944640aca69521c7b1bc8a11dadb40b939',
  'packages/paper-engine/test/execution-start-fixtures.ts':
    '014885dcc8d5833112af9bc04bf6ab0be607125697e1a52ac1cdd78d9fdc60f3',
  'packages/paper-engine/test/fixtures.ts':
    '225f3ff380692d1fef70c2563d0d9f8ab9455deca48678090b0db6f22212b7f1',
  'packages/paper-engine/test/frame-fixture.ts':
    '1ed49e8898124c61e9ca2ba56f8cfbda39589ff79bacc642de5f1c3c93be1d62',
  'packages/paper-engine/test/prepared-execution-source-fixtures.ts':
    'f6b30d7202c0d1da7ca6aa8c598c4039cdbca15042a52fa4e696089d5bc858eb',
  'packages/paper-engine/test/started-execution-fixtures.ts':
    '11381ed27383b21114590fa43628b67ca776c890f97f8e8b98190e93654325ed',
  'packages/portfolio/test/fixtures.ts':
    'bf5fe4967ec1a890e589bab4b1029551afe4d37bad7b4b91d68e8f5b280c3216',
  'packages/risk-engine/test/fixtures.ts':
    'bec4bb8c658e9c4c1afc381791a8feef7299536464eb4b06ade981e2e7738a4f',
  'packages/risk-engine/test/snapshot-fixtures.ts':
    '2ea934e6f348527ba680537e8d60cb4c85fff245fb5c0cb029ec309fd0c9a632',
});
export const scopedMainManifestHash = createHash('sha256')
  .update(
    JSON.stringify({
      nameScheme: 'fresh-hex12-xor-one-v1',
      roots: scopedMainFiles,
      sources: scopedMainSources,
    }),
  )
  .digest('hex');
export function scopedMainDatabaseName(main) {
  if (typeof main !== 'string' || !/^ctp_p2_fresh_[a-f0-9]{12}$/.test(main))
    throw Error('NATIVE_SCOPED_DATABASE_NAME');
  const suffix = (BigInt('0x' + main.slice(-12)) ^ 1n).toString(16).padStart(12, '0');
  return 'ctp_p2_fresh_' + suffix;
}
export async function verifyScopedMainFiles(root = workspace) {
  for (const [file, expected] of Object.entries(scopedMainSources)) {
    const target = path.resolve(root, file);
    assert(target.startsWith(path.resolve(root) + path.sep));
    const source = (await readFile(target, 'utf8')).replaceAll('\r\n', '\n');
    assert.equal(
      createHash('sha256').update(source).digest('hex'),
      expected,
      'Scoped native input requires renewed cluster-role review: ' + file,
    );
  }
  return {
    manifest: scopedMainManifestHash,
    roots: scopedMainFiles.length,
    sources: Object.keys(scopedMainSources).length,
  };
}
