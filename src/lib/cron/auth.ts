import { timingSafeEqual } from 'node:crypto';

/**
 * Shared authorization for the scheduled endpoints
 * (`/api/automations/cron`, `/api/flows/cron`).
 *
 * Two callers, two conventions:
 *
 *   - An external pinger (cron-job.org, a GitHub Action, a VPS
 *     crontab) can set any header, and this repo's convention is
 *     `x-cron-secret: $AUTOMATION_CRON_SECRET`.
 *   - **Vercel Cron cannot set headers at all.** A `crons` entry in
 *     vercel.json takes only `path` and `schedule`; Vercel sends
 *     `Authorization: Bearer $CRON_SECRET` and nothing else. Against
 *     an `x-cron-secret`-only check every Vercel invocation returns
 *     401, so automations with Wait steps silently never resume.
 *     https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
 *
 * So both are accepted. `CRON_SECRET` is Vercel's own variable name;
 * `AUTOMATION_CRON_SECRET` also works as a bearer token so a
 * single-platform operator only has to provision one secret.
 */
export type CronAuthResult = 'ok' | 'unauthorized' | 'not_configured';

/**
 * Constant-time compare so an attacker who can reach the endpoint
 * can't recover the secret byte-by-byte from response-time deltas.
 * The length pre-check is required by `timingSafeEqual` (it throws on
 * a mismatch) and leaks only the length, which isn't sensitive.
 */
function secretMatches(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (suppliedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(suppliedBuf, expectedBuf);
}

export function authorizeCronRequest(request: Request): CronAuthResult {
  const automationSecret = process.env.AUTOMATION_CRON_SECRET ?? '';
  const vercelSecret = process.env.CRON_SECRET ?? '';

  // Neither provisioned: the endpoint is off rather than open. Kept
  // distinct from `unauthorized` so an operator sees "you forgot to
  // set the secret" instead of hunting a wrong value.
  if (!automationSecret && !vercelSecret) return 'not_configured';

  const header = request.headers.get('x-cron-secret') ?? '';
  if (automationSecret && secretMatches(header, automationSecret)) return 'ok';

  const auth = request.headers.get('authorization') ?? '';
  // Meta-style prefix check before the constant-time compare: the
  // scheme is public, only the token needs protecting.
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length);
    if (vercelSecret && secretMatches(token, vercelSecret)) return 'ok';
    if (automationSecret && secretMatches(token, automationSecret)) return 'ok';
  }

  return 'unauthorized';
}
