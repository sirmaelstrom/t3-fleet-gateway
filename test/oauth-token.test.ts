import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { NEVER_EXPIRES, REFRESH_GRACE } from '../src/oauth/tokens.ts';
import { DAY, HOUR, MINUTE, SECOND } from '../src/time.ts';
import { startOAuthHarness, type OAuthHarness } from './helpers/oauthHarness.ts';
import {
  authorizationResponse,
  authorizeUrl,
  CALLBACK,
  loadApprovalPage,
  pkcePair,
  registerClient,
  signIn,
  standardAuthorizeParams,
  submitApproval,
  tokenRequest,
  type IssuedTokens,
} from './helpers/oauthFlow.ts';

async function authorizationCode(h: OAuthHarness): Promise<{ clientId: string; code: string; verifier: string }> {
  const clientId = await registerClient(h.baseUrl);
  const { verifier, challenge } = pkcePair();
  const page = await loadApprovalPage(authorizeUrl(h.baseUrl, standardAuthorizeParams(clientId, challenge)));
  const approval = await submitApproval(h.baseUrl, page.fields, { approval_code: h.approvals.mint().code });
  const code = (await authorizationResponse(approval)).searchParams.get('code') ?? '';
  return { clientId, code, verifier };
}

async function expectError(response: Response, error: string, status = 400): Promise<void> {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(((await response.json()) as { error: string }).error, error);
}

function refresh(h: OAuthHarness, clientId: string, refreshToken: string, extra: Record<string, string> = {}): Promise<Response> {
  return tokenRequest(h.baseUrl, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, ...extra });
}

const mintFor = (h: OAuthHarness) => () => h.approvals.mint().code;

describe('token endpoint: authorization_code', () => {
  test('exchanges a code with PKCE for an access and refresh token', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, code, verifier } = await authorizationCode(h);
    const response = await tokenRequest(h.baseUrl, {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      resource: h.resource,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const tokens = (await response.json()) as IssuedTokens;
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.expires_in, 3600);
    assert.equal(tokens.scope, 'fleet:read');
    assert.equal(Buffer.from(tokens.access_token, 'base64url').length, 32, '256-bit token');
    const verified = h.tokens.verifyAccessToken(tokens.access_token);
    assert.equal(verified?.clientId, clientId);
    assert.deepEqual(verified?.scopes, ['fleet:read']);
    assert.equal(verified?.resource, h.resource);
  });

  test('rejects a wrong or missing PKCE verifier', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, code } = await authorizationCode(h);
    const base = { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CALLBACK };
    await expectError(await tokenRequest(h.baseUrl, { ...base, code_verifier: pkcePair().verifier }), 'invalid_grant');
    await expectError(await tokenRequest(h.baseUrl, base), 'invalid_grant');
  });

  test('requires the same client, redirect URI and resource', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, code, verifier } = await authorizationCode(h);
    const other = await registerClient(h.baseUrl);
    const base = { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CALLBACK, code_verifier: verifier };
    await expectError(await tokenRequest(h.baseUrl, { ...base, client_id: other }), 'invalid_grant');
    await expectError(await tokenRequest(h.baseUrl, { ...base, redirect_uri: 'https://agent.example.com/x' }), 'invalid_grant');
    await expectError(await tokenRequest(h.baseUrl, { ...base, resource: 'https://other.example.com/mcp' }), 'invalid_target');
    assert.equal((await tokenRequest(h.baseUrl, base)).status, 200, 'failed attempts did not consume the code');
  });

  test('codes are single use; a replay revokes the tokens they produced', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, code, verifier } = await authorizationCode(h);
    const request = { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CALLBACK, code_verifier: verifier };
    const tokens = (await (await tokenRequest(h.baseUrl, request)).json()) as IssuedTokens;
    await expectError(await tokenRequest(h.baseUrl, request), 'invalid_grant');
    assert.equal(h.tokens.verifyAccessToken(tokens.access_token), undefined);
    await expectError(await refresh(h, clientId, tokens.refresh_token), 'invalid_grant');
  });

  test('codes expire after 60 seconds', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, code, verifier } = await authorizationCode(h);
    h.clock.advance(61 * SECOND);
    await expectError(
      await tokenRequest(h.baseUrl, { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CALLBACK, code_verifier: verifier }),
      'invalid_grant',
    );
  });

  test('validates the request shape', async (t) => {
    const h = await startOAuthHarness(t);
    const clientId = await registerClient(h.baseUrl);
    await expectError(await tokenRequest(h.baseUrl, { grant_type: 'authorization_code', code: 'x' }), 'invalid_request');
    await expectError(await tokenRequest(h.baseUrl, { grant_type: 'client_credentials', client_id: clientId }), 'unsupported_grant_type');
    await expectError(await tokenRequest(h.baseUrl, { grant_type: 'authorization_code', code: 'x', client_id: 'nope' }), 'invalid_client', 401);
    const json = await fetch(`${h.baseUrl}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(json.status, 415);
  });
});

describe('token endpoint: refresh_token', () => {
  test('rotates the pair and retires the old access token', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, tokens } = await signIn(h.baseUrl, mintFor(h));
    const response = await refresh(h, clientId, tokens.refresh_token, { resource: h.resource });
    assert.equal(response.status, 200);
    const next = (await response.json()) as IssuedTokens;
    assert.notEqual(next.refresh_token, tokens.refresh_token);
    assert.notEqual(next.access_token, tokens.access_token);
    assert.equal(h.tokens.verifyAccessToken(tokens.access_token), undefined);
    assert.ok(h.tokens.verifyAccessToken(next.access_token));
    assert.equal((await refresh(h, clientId, next.refresh_token)).status, 200, 'the new refresh token works');
  });

  test('a retry within the grace window gets a sibling pair and leaves the first pair valid', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, tokens } = await signIn(h.baseUrl, mintFor(h));
    const first = (await (await refresh(h, clientId, tokens.refresh_token)).json()) as IssuedTokens;
    h.clock.advance(REFRESH_GRACE - SECOND);
    const retried = await refresh(h, clientId, tokens.refresh_token);
    assert.equal(retried.status, 200);
    const second = (await retried.json()) as IssuedTokens;
    assert.ok(h.tokens.verifyAccessToken(second.access_token));
    assert.ok(h.tokens.verifyAccessToken(first.access_token), 'the client may have kept the first pair');
    assert.equal((await refresh(h, clientId, first.refresh_token)).status, 200, 'either sibling can be rotated');
    assert.ok(h.logs.some((line) => line.includes('"event":"oauth.refresh_retry_accepted"')));
  });

  test('concurrent refreshes with the same token both succeed, and the client is never logged out by the race', async (t) => {
    for (const kept of [0, 1] as const) {
      const h = await startOAuthHarness(t);
      const { clientId, tokens } = await signIn(h.baseUrl, mintFor(h));
      const responses = await Promise.all([refresh(h, clientId, tokens.refresh_token), refresh(h, clientId, tokens.refresh_token)]);
      assert.deepEqual(responses.map((response) => response.status), [200, 200]);
      const pairs = (await Promise.all(responses.map((response) => response.json()))) as IssuedTokens[];
      for (const pair of pairs) assert.ok(h.tokens.verifyAccessToken(pair.access_token), 'both access tokens work');
      // The client keeps whichever pair it saved last and rotates that one; the other sibling is then superseded.
      const keptPair = pairs[kept]!;
      const otherPair = pairs[1 - kept]!;
      const rotated = await refresh(h, clientId, keptPair.refresh_token);
      assert.equal(rotated.status, 200, `sibling ${kept} can be rotated`);
      const next = (await rotated.json()) as IssuedTokens;
      assert.equal((await refresh(h, clientId, next.refresh_token)).status, 200, 'the chain continues normally');
      await expectError(await refresh(h, clientId, otherPair.refresh_token), 'invalid_grant');
      assert.ok(h.logs.some((line) => line.includes('"event":"oauth.token_family_revoked"') && line.includes('refresh_token_reuse')));
    }
  });

  test('after concurrent refreshes, reusing the original token after the grace window revokes the family', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, tokens } = await signIn(h.baseUrl, mintFor(h));
    const pairs = (await Promise.all(
      [refresh(h, clientId, tokens.refresh_token), refresh(h, clientId, tokens.refresh_token)].map(async (response) => (await response).json()),
    )) as IssuedTokens[];
    h.clock.advance(REFRESH_GRACE + SECOND);
    await expectError(await refresh(h, clientId, tokens.refresh_token), 'invalid_grant');
    for (const pair of pairs) {
      assert.equal(h.tokens.verifyAccessToken(pair.access_token), undefined);
      await expectError(await refresh(h, clientId, pair.refresh_token), 'invalid_grant');
    }
  });

  test('reuse after the grace window revokes the whole family', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, tokens } = await signIn(h.baseUrl, mintFor(h));
    const next = (await (await refresh(h, clientId, tokens.refresh_token)).json()) as IssuedTokens;
    h.clock.advance(REFRESH_GRACE + SECOND);
    await expectError(await refresh(h, clientId, tokens.refresh_token), 'invalid_grant');
    assert.equal(h.tokens.verifyAccessToken(next.access_token), undefined);
    await expectError(await refresh(h, clientId, next.refresh_token), 'invalid_grant');
    assert.ok(h.logs.some((line) => line.includes('"event":"oauth.token_family_revoked"') && line.includes('refresh_token_reuse')));
  });

  test('replaying a rotated token after its successor was used revokes the family even inside the grace window', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, tokens } = await signIn(h.baseUrl, mintFor(h));
    const second = (await (await refresh(h, clientId, tokens.refresh_token)).json()) as IssuedTokens;
    const third = (await (await refresh(h, clientId, second.refresh_token)).json()) as IssuedTokens;
    await expectError(await refresh(h, clientId, tokens.refresh_token), 'invalid_grant');
    assert.equal(h.tokens.verifyAccessToken(third.access_token), undefined);
  });

  test('once one sibling is rotated, presenting another (superseded) sibling revokes the family', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, tokens } = await signIn(h.baseUrl, mintFor(h));
    const first = (await (await refresh(h, clientId, tokens.refresh_token)).json()) as IssuedTokens;
    const second = (await (await refresh(h, clientId, tokens.refresh_token)).json()) as IssuedTokens;
    const current = (await (await refresh(h, clientId, second.refresh_token)).json()) as IssuedTokens;
    await expectError(await refresh(h, clientId, first.refresh_token), 'invalid_grant');
    assert.equal(h.tokens.verifyAccessToken(current.access_token), undefined);
    await expectError(await refresh(h, clientId, current.refresh_token), 'invalid_grant');
  });

  test('refresh tokens expire after the idle period; access tokens after their TTL', async (t) => {
    const h = await startOAuthHarness(t, { accessTtlSeconds: 600, refreshIdleTtlDays: 7 });
    const { clientId, tokens } = await signIn(h.baseUrl, mintFor(h));
    h.clock.advance(10 * MINUTE);
    assert.equal(h.tokens.verifyAccessToken(tokens.access_token), undefined);
    const active = (await (await refresh(h, clientId, tokens.refresh_token)).json()) as IssuedTokens;
    h.clock.advance(6 * DAY);
    const stillActive = (await (await refresh(h, clientId, active.refresh_token)).json()) as IssuedTokens;
    h.clock.advance(7 * DAY);
    await expectError(await refresh(h, clientId, stillActive.refresh_token), 'invalid_grant');
  });

  test('scope can be narrowed but never widened', async (t) => {
    const h = await startOAuthHarness(t);
    const read = await signIn(h.baseUrl, mintFor(h), { access: 'read' });
    await expectError(await refresh(h, read.clientId, read.tokens.refresh_token, { scope: 'fleet:read fleet:operate' }), 'invalid_scope');
    const operate = await signIn(h.baseUrl, mintFor(h), { access: 'operate' });
    const narrowed = (await (await refresh(h, operate.clientId, operate.tokens.refresh_token, { scope: 'fleet:read' })).json()) as IssuedTokens;
    assert.equal(narrowed.scope, 'fleet:read');
  });

  test('refresh tokens are bound to their client', async (t) => {
    const h = await startOAuthHarness(t);
    const { tokens } = await signIn(h.baseUrl, mintFor(h));
    const other = await registerClient(h.baseUrl);
    await expectError(await refresh(h, other, tokens.refresh_token), 'invalid_grant');
  });
});

describe('revocation and storage', () => {
  test('revoking a client invalidates its access and refresh tokens', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, tokens } = await signIn(h.baseUrl, mintFor(h));
    const other = await signIn(h.baseUrl, mintFor(h));
    assert.deepEqual(h.clients.revoke(clientId), { families: 1 });
    assert.equal(h.tokens.verifyAccessToken(tokens.access_token), undefined);
    await expectError(await refresh(h, clientId, tokens.refresh_token), 'invalid_client', 401);
    assert.ok(h.tokens.verifyAccessToken(other.tokens.access_token), 'other clients are unaffected');
    assert.equal(h.clients.revoke('unknown'), undefined);
  });

  test('stores only hashes of tokens and codes', async (t) => {
    const h = await startOAuthHarness(t);
    const { code: approvalCode } = h.approvals.mint();
    const { tokens } = await signIn(h.baseUrl, () => approvalCode);
    const dump = JSON.stringify(
      ['approval_codes', 'authorization_codes', 'access_tokens', 'refresh_tokens'].map((table) => h.db.prepare(`SELECT * FROM ${table}`).all()),
    );
    for (const secret of [tokens.access_token, tokens.refresh_token, approvalCode, approvalCode.replace('-', '')]) {
      assert.equal(dump.includes(secret), false);
    }
  });
});

describe('operator tokens (clients token)', () => {
  test('work for their scopes until they expire, are stored as hashes and need no refresh', async (t) => {
    const h = await startOAuthHarness(t);
    const now = h.clock();
    const operate = h.tokens.issueOperatorToken({ name: 'Synthetic agent', scopes: ['fleet:read', 'fleet:operate'], expiresAt: now + HOUR });
    const read = h.tokens.issueOperatorToken({ name: 'Synthetic reader', scopes: ['fleet:read'], expiresAt: NEVER_EXPIRES });
    assert.deepEqual(h.tokens.verifyAccessToken(operate.token), {
      operatorTokenId: operate.tokenId,
      clientId: operate.clientId,
      familyId: h.tokens.verifyAccessToken(operate.token)?.familyId,
      scopes: ['fleet:read', 'fleet:operate'],
      expiresAt: now + HOUR,
      resource: h.resource,
    });
    assert.deepEqual(h.tokens.verifyAccessToken(read.token)?.scopes, ['fleet:read']);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get()?.n, 0, 'no refresh token is issued');
    const dump = JSON.stringify(['oauth_clients', 'token_families', 'access_tokens'].map((table) => h.db.prepare(`SELECT * FROM ${table}`).all()));
    assert.equal(dump.includes(operate.token) || dump.includes(read.token), false);

    h.clock.advance(HOUR);
    assert.equal(h.tokens.verifyAccessToken(operate.token), undefined, 'expired at expiresAt');
    h.clock.advance(100 * 365 * DAY);
    assert.ok(h.tokens.verifyAccessToken(read.token), 'a token minted with --ttl never does not expire');
  });

  test('revoking the client cuts the token off; it cannot authorize, refresh or count toward registrations', async (t) => {
    const h = await startOAuthHarness(t);
    const { clientId, token } = h.tokens.issueOperatorToken({ name: 'Synthetic agent', scopes: ['fleet:read'], expiresAt: NEVER_EXPIRES });
    assert.equal(h.clients.registrationsCounted(), 0);
    const { challenge } = pkcePair();
    const authorize = await fetch(authorizeUrl(h.baseUrl, standardAuthorizeParams(clientId, challenge)), { redirect: 'manual' });
    assert.deepEqual([authorize.status, authorize.headers.get('location')], [400, null], 'no redirect URI is registered for it');
    await expectError(await refresh(h, clientId, token), 'invalid_grant');

    // Cleaning up registrations that never completed an approval keeps it: it has a grant.
    h.clock.advance(2 * DAY);
    await registerClient(h.baseUrl);
    assert.ok(h.tokens.verifyAccessToken(token));
    assert.deepEqual(h.clients.revoke(clientId), { families: 1 });
    assert.equal(h.tokens.verifyAccessToken(token), undefined);
  });
});


test('operator rotation keeps identity, bounds overlaps, records independent usage and revokes immediately', async (t) => {
  const h = await startOAuthHarness(t);
  const first = h.tokens.issueOperatorToken({ name: 'Rotation bot', scopes: ['host:main:read'], expiresAt: h.clock() + 2 * DAY });
  const second = h.tokens.rotateOperatorToken(first.clientId, first.tokenId, HOUR, NEVER_EXPIRES);
  assert.equal(h.tokens.verifyAccessToken(second.token)?.clientId, first.clientId);
  assert.deepEqual(h.tokens.verifyAccessToken(second.token)?.scopes, ['host:main:read']);
  assert.ok(h.tokens.verifyAccessToken(first.token));
  h.tokens.recordOperatorCall(first.tokenId);
  h.tokens.recordOperatorCall(second.tokenId);
  h.tokens.recordOperatorCall(second.tokenId);
  let inventory = h.tokens.operatorTokens(first.clientId);
  assert.equal(inventory.find((v) => v.id === second.tokenId)?.calls24Hours, 2);
  assert.equal(inventory.find((v) => v.id === first.tokenId)?.calls24Hours, 1);
  assert.equal(inventory.find((v) => v.id === first.tokenId)?.lastUsedAt, h.clock());
  assert.ok(!JSON.stringify(inventory).includes(first.token));
  assert.ok(!JSON.stringify(inventory).includes('token_hash'));
  const third = h.tokens.rotateOperatorToken(first.clientId, second.tokenId, 0, NEVER_EXPIRES);
  assert.equal(h.tokens.verifyAccessToken(second.token), undefined, 'zero overlap');
  assert.ok(h.tokens.verifyAccessToken(first.token), 'rotating another token does not revoke a previous overlap');
  h.clock.advance(HOUR);
  assert.equal(h.tokens.verifyAccessToken(first.token), undefined, 'exact overlap boundary');
  assert.ok(h.tokens.verifyAccessToken(third.token));
  h.tokens.revokeOperatorToken(first.clientId, third.tokenId);
  assert.equal(h.tokens.verifyAccessToken(third.token), undefined);
  assert.throws(() => h.tokens.rotateOperatorToken(first.clientId, third.tokenId, HOUR, NEVER_EXPIRES), { code: 'not_found' });
  h.clock.advance(DAY);
  inventory = h.tokens.operatorTokens(first.clientId);
  assert.ok(inventory.every((v) => v.calls24Hours === 0));
  assert.equal(inventory.find((v) => v.id === second.tokenId)?.lastUsedAt, h.clock() - DAY - HOUR);
});

test('rotation never extends old expiry, cannot cross clients, and client revocation revokes both tokens', async (t) => {
  const h = await startOAuthHarness(t);
  const a = h.tokens.issueOperatorToken({ name: 'A', scopes: ['fleet:read'], expiresAt: h.clock() + HOUR });
  const b = h.tokens.issueOperatorToken({ name: 'B', scopes: ['fleet:read'], expiresAt: NEVER_EXPIRES });
  assert.throws(() => h.tokens.rotateOperatorToken(b.clientId, a.tokenId, DAY, NEVER_EXPIRES), { code: 'not_found' });
  assert.throws(() => h.tokens.revokeOperatorToken(b.clientId, a.tokenId), { code: 'not_found' });
  const next = h.tokens.rotateOperatorToken(a.clientId, a.tokenId, DAY, NEVER_EXPIRES);
  assert.equal(h.tokens.operatorTokens(a.clientId).find((v) => v.id === a.tokenId)?.expiresAt, h.clock() + HOUR);
  h.clients.revoke(a.clientId);
  assert.equal(h.tokens.verifyAccessToken(a.token), undefined);
  assert.equal(h.tokens.verifyAccessToken(next.token), undefined);
  assert.ok(h.tokens.verifyAccessToken(b.token));
});
