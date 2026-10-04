import { describe, expect, it } from 'vitest';
import { verifyAccountConfiguration } from '../src/auth.js';
import { account, now, scope } from './fixtures.js';
const config = {
  uid: account.externalAccountId,
  acctLv: '2',
  posMode: 'net_mode',
  perm: 'read_only,trade',
  autoLoan: false,
  roleType: '0',
  spotRoleType: '0',
  stgyType: '0',
};
describe('OKX native configuration is additional fresh permission evidence', () => {
  it('only native exact UID and approved mode produce account evidence', () => {
    expect(verifyAccountConfiguration([config], account, scope, now)).toMatchObject({
      permissions: ['READ', 'TRADE'],
      positionMode: 'ONE_WAY',
    });
  });
  it.each([
    { uid: 'other' },
    { perm: 'read_only,trade,withdraw' },
    { perm: 'trade' },
    { perm: 'read_only,future_permission' },
    { acctLv: '3' },
    { posMode: 'long_short_mode' },
    { autoLoan: true },
    { roleType: '1' },
    { spotRoleType: '1' },
    { stgyType: '1' },
  ])('rejects incompatible evidence %j', (fields) => {
    expect(() =>
      verifyAccountConfiguration([{ ...config, ...fields }], account, scope, now),
    ).toThrow();
  });
  it('read-only configuration cannot claim trade permissions', () => {
    expect(
      verifyAccountConfiguration([{ ...config, perm: 'read_only' }], account, scope, now)
        .permissions,
    ).toEqual(['READ']);
  });
  it.each([{ rows: [] }, { rows: [config, config] }])(
    'requires exactly one account configuration',
    ({ rows }) => {
      expect(() => verifyAccountConfiguration(rows, account, scope, now)).toThrow();
    },
  );
});
