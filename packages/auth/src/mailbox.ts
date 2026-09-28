/** Canonical product grammar, deliberately narrower than the SMTP RFC mailbox grammar. */
export function isNormalizedMailbox(value: string): boolean {
  return (
    value.length <= 254 &&
    value === value.trim() &&
    value.slice(0, value.indexOf('@')).length <= 64 &&
    /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      value,
    )
  );
}
