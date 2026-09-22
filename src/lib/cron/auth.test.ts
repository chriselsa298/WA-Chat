import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorizeCronRequest } from './auth';

const ORIGINAL = {
  AUTOMATION_CRON_SECRET: process.env.AUTOMATION_CRON_SECRET,
  CRON_SECRET: process.env.CRON_SECRET,
};

function req(headers: Record<string, string>): Request {
  return new Request('https://crm.example.com/api/automations/cron', {
    headers,
  });
}

beforeEach(() => {
  delete process.env.AUTOMATION_CRON_SECRET;
  delete process.env.CRON_SECRET;
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('authorizeCronRequest', () => {
  it('reports a missing configuration instead of rejecting', () => {
    // An operator who never set a secret needs "you forgot to
    // configure this", not a 401 they will hunt for hours.
    expect(authorizeCronRequest(req({}))).toBe('not_configured');
  });

  it('accepts the x-cron-secret header an external pinger sends', () => {
    process.env.AUTOMATION_CRON_SECRET = 'pinger-secret';
    expect(
      authorizeCronRequest(req({ 'x-cron-secret': 'pinger-secret' }))
    ).toBe('ok');
  });

  it('accepts the bearer token Vercel Cron sends', () => {
    // Vercel cannot set custom headers on a cron invocation, so this
    // is the only shape its requests can take.
    process.env.CRON_SECRET = 'vercel-secret';
    expect(
      authorizeCronRequest(req({ authorization: 'Bearer vercel-secret' }))
    ).toBe('ok');
  });

  it('accepts AUTOMATION_CRON_SECRET as a bearer token too', () => {
    // So an operator running only on Vercel provisions one secret,
    // not two.
    process.env.AUTOMATION_CRON_SECRET = 'one-secret';
    expect(
      authorizeCronRequest(req({ authorization: 'Bearer one-secret' }))
    ).toBe('ok');
  });

  it('rejects a wrong secret in either header', () => {
    process.env.AUTOMATION_CRON_SECRET = 'right';
    process.env.CRON_SECRET = 'also-right';
    expect(authorizeCronRequest(req({ 'x-cron-secret': 'wrong' }))).toBe(
      'unauthorized'
    );
    expect(authorizeCronRequest(req({ authorization: 'Bearer wrong' }))).toBe(
      'unauthorized'
    );
  });

  it('rejects a secret of a different length without throwing', () => {
    // timingSafeEqual throws on unequal buffer lengths; the guard has
    // to come first or every short guess is a 500, not a 401.
    process.env.AUTOMATION_CRON_SECRET = 'a-fairly-long-secret';
    expect(authorizeCronRequest(req({ 'x-cron-secret': 'x' }))).toBe(
      'unauthorized'
    );
  });

  it('rejects an empty secret presented against a configured one', () => {
    process.env.CRON_SECRET = 'vercel-secret';
    expect(authorizeCronRequest(req({ authorization: 'Bearer ' }))).toBe(
      'unauthorized'
    );
    expect(authorizeCronRequest(req({ 'x-cron-secret': '' }))).toBe(
      'unauthorized'
    );
  });

  it('rejects a non-bearer authorization scheme', () => {
    process.env.CRON_SECRET = 'vercel-secret';
    expect(
      authorizeCronRequest(req({ authorization: 'Basic vercel-secret' }))
    ).toBe('unauthorized');
  });

  it('does not let one secret unlock the other header', () => {
    // Only CRON_SECRET is set: the x-cron-secret path must stay shut.
    process.env.CRON_SECRET = 'vercel-secret';
    expect(
      authorizeCronRequest(req({ 'x-cron-secret': 'vercel-secret' }))
    ).toBe('unauthorized');
  });
});
