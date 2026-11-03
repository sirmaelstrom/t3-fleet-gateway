import { isValidPkceVerifier, pkceChallenge, randomId, randomToken, safeEqual, sha256Hex } from '../crypto.ts';
import { transaction, type Database } from '../db/database.ts';
import { DAY, HOUR, MINUTE, SECOND, type Clock } from '../time.ts';
import { GatewayError } from '../errors.ts';
import { OAuthError } from './errors.ts';
import { effectiveScopes } from './threadScopes.ts';
import { formatScope, narrowScopes, parseScope, type Scope } from './scopes.ts';

export const AUTHORIZATION_CODE_TTL = 60 * SECOND;
/**
 * A rotated refresh token presented again within this window is a client retry (a lost response, or
 * concurrent requests refreshing with the same token): it gets another pair alongside the first.
 */
export const REFRESH_GRACE = 2 * MINUTE;
/** `expiresAt` of an operator token that does not expire (`clients token --ttl never`): later than any clock reading. */
export const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;

export interface TokenSettings {
  /** Canonical resource (audience) that every token is bound to. */
  resource: string;
  accessTtlSeconds: number;
  refreshIdleTtlDays: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface VerifiedAccessToken {
  operatorTokenId?: string;
  clientId: string;
  familyId: string;
  scopes: Scope[];
  /** Unix milliseconds. */
  expiresAt: number;
  resource: string;
}

export type TokenEvent =
  | { type: 'issued'; clientId: string; familyId: string; grant: 'authorization_code' | 'refresh_token' }
  | { type: 'refresh_retry'; clientId: string; familyId: string }
  | { type: 'family_revoked'; clientId: string; familyId: string; reason: 'refresh_token_reuse' | 'authorization_code_reuse' };

interface RefreshRow {
  token_hash: string;
  family_id: string;
  scope: string;
  expires_at: number;
  parent_hash: string | null;
  rotated_at: number | null;
  superseded_at: number | null;
  client_id: string;
  resource: string;
  family_revoked_at: number | null;
  client_revoked_at: number | null;
}

/** Shared by grant diagnostics; inclusive grace boundary and child rotation must match refresh enforcement. */
export function refreshIsReplay(row: { superseded_at: number | null; rotated_at: number | null }, now: number, childWasRotated: boolean): boolean {
  return row.superseded_at !== null || (row.rotated_at !== null && (now - row.rotated_at > REFRESH_GRACE || childWasRotated));
}

export function accessIsUsable(row: {
  revoked_at: number | null; family_revoked_at: number | null; client_revoked_at: number | null; expires_at: number; resource: string;
}, now: number, resource: string): boolean {
  return row.revoked_at === null && row.family_revoked_at === null && row.client_revoked_at === null
    && row.expires_at > now && resourceMatches(row.resource, resource);
}

const hashToken = (token: string): string => sha256Hex(token);

export function resourceMatches(candidate: string, resource: string): boolean {
  return candidate.replace(/\/$/, '') === resource.replace(/\/$/, '');
}

/**
 * Authorization codes, access tokens and rotating refresh tokens. Only SHA-256 hashes of codes and
 * tokens are stored. Refresh tokens rotate on every use and remember the token they were issued
 * from (`parent_hash`). Presenting a rotated token again within the grace window issues another pair
 * from it, a sibling of the first; siblings stay valid side by side, because a client that refreshed
 * twice concurrently keeps whichever pair it saved last. The first time any sibling is rotated, the
 * client has settled on it: the other siblings are superseded and the parent can no longer be
 * retried. Presenting a superseded token, or a rotated one after the grace window or after one of
 * its children was rotated, revokes the whole family.
 */
export class TokenService {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #settings: TokenSettings;
  readonly #onEvent: (event: TokenEvent) => void;

  constructor(db: Database, clock: Clock, settings: TokenSettings, onEvent: (event: TokenEvent) => void = () => {}) {
    this.#db = db;
    this.#clock = clock;
    this.#settings = settings;
    this.#onEvent = onEvent;
  }

  get resource(): string {
    return this.#settings.resource;
  }

  issueAuthorizationCode(grant: { clientId: string; redirectUri: string; codeChallenge: string; scopes: Scope[] }): string {
    const code = randomToken();
    const now = this.#clock();
    this.#db.prepare('DELETE FROM authorization_codes WHERE expires_at < ?').run(now - DAY);
    this.#db
      .prepare(
        `INSERT INTO authorization_codes (code_hash, client_id, redirect_uri, code_challenge, resource, scope, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hashToken(code),
        grant.clientId,
        grant.redirectUri,
        grant.codeChallenge,
        this.#settings.resource,
        formatScope(grant.scopes),
        now,
        now + AUTHORIZATION_CODE_TTL,
      );
    return code;
  }

  /** Whether a code can still be exchanged: known, unused and unexpired. */
  authorizationCodePending(code: string): boolean {
    const row = this.#db.prepare('SELECT used_at, expires_at FROM authorization_codes WHERE code_hash = ?').get(hashToken(code)) as
      | { used_at: number | null; expires_at: number }
      | undefined;
    return row !== undefined && row.used_at === null && row.expires_at > this.#clock();
  }

  exchangeAuthorizationCode(request: {
    code: string;
    clientId: string;
    redirectUri: string | undefined;
    codeVerifier: string | undefined;
    resource: string | undefined;
  }): TokenResponse {
    const now = this.#clock();
    const outcome = transaction(this.#db, () => {
      const row = this.#db
        .prepare(
          `SELECT a.*, c.revoked_at AS client_revoked_at FROM authorization_codes a
             JOIN oauth_clients c ON c.id = a.client_id WHERE a.code_hash = ?`,
        )
        .get(hashToken(request.code)) as
        | {
            client_id: string;
            redirect_uri: string;
            code_challenge: string;
            resource: string;
            scope: string;
            expires_at: number;
            used_at: number | null;
            family_id: string | null;
            client_revoked_at: number | null;
          }
        | undefined;
      if (!row) return { error: new OAuthError('invalid_grant', 'Unknown authorization code') };
      if (row.used_at !== null) {
        // A replayed code means it leaked; revoke what it produced (RFC 6749 section 4.1.2).
        if (row.family_id) this.#revokeFamily(row.family_id, 'authorization_code_reuse', now);
        return {
          error: new OAuthError('invalid_grant', 'Authorization code was already used'),
          event: row.family_id
            ? ({ type: 'family_revoked', clientId: row.client_id, familyId: row.family_id, reason: 'authorization_code_reuse' } as const)
            : undefined,
        };
      }
      if (row.client_id !== request.clientId) return { error: new OAuthError('invalid_grant', 'Code was issued to another client') };
      if (row.client_revoked_at !== null) return { error: new OAuthError('invalid_grant', 'Client has been revoked') };
      if (row.expires_at <= now) return { error: new OAuthError('invalid_grant', 'Authorization code expired') };
      if (request.redirectUri !== row.redirect_uri) return { error: new OAuthError('invalid_grant', 'redirect_uri does not match') };
      if (!request.codeVerifier || !isValidPkceVerifier(request.codeVerifier)) {
        return { error: new OAuthError('invalid_grant', 'A valid code_verifier is required') };
      }
      if (!safeEqual(pkceChallenge(request.codeVerifier), row.code_challenge)) {
        return { error: new OAuthError('invalid_grant', 'PKCE verification failed') };
      }
      if (request.resource !== undefined && !resourceMatches(request.resource, row.resource)) {
        return { error: new OAuthError('invalid_target', 'resource does not match this server') };
      }
      const familyId = randomId(12);
      this.#db
        .prepare('INSERT INTO token_families (id, client_id, scope, resource, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(familyId, row.client_id, row.scope, row.resource, now);
      this.#db
        .prepare('UPDATE authorization_codes SET used_at = ?, family_id = ? WHERE code_hash = ?')
        .run(now, familyId, hashToken(request.code));
      return {
        response: this.#issuePair(familyId, row.scope, now),
        event: { type: 'issued', clientId: row.client_id, familyId, grant: 'authorization_code' } as const,
      };
    });
    if (outcome.event) this.#onEvent(outcome.event);
    if ('error' in outcome) throw outcome.error;
    return outcome.response;
  }

  refresh(request: { refreshToken: string; clientId: string; scope: string | undefined; resource: string | undefined }): TokenResponse {
    const now = this.#clock();
    const outcome = transaction(this.#db, () => {
      const row = this.#db
        .prepare(
          `SELECT r.*, f.client_id, f.resource, f.revoked_at AS family_revoked_at, c.revoked_at AS client_revoked_at
             FROM refresh_tokens r JOIN token_families f ON f.id = r.family_id JOIN oauth_clients c ON c.id = f.client_id
             WHERE r.token_hash = ?`,
        )
        .get(hashToken(request.refreshToken)) as RefreshRow | undefined;
      if (!row || row.client_id !== request.clientId) return { error: new OAuthError('invalid_grant', 'Unknown refresh token') };
      if (row.family_revoked_at !== null || row.client_revoked_at !== null) {
        return { error: new OAuthError('invalid_grant', 'Refresh token has been revoked') };
      }
      const replay = refreshIsReplay(row, now, row.rotated_at !== null && this.#childWasRotated(row.token_hash));
      if (replay) {
        this.#revokeFamily(row.family_id, 'refresh_token_reuse', now);
        return {
          error: new OAuthError('invalid_grant', 'Refresh token was already used; all tokens for this grant are revoked'),
          event: { type: 'family_revoked', clientId: row.client_id, familyId: row.family_id, reason: 'refresh_token_reuse' } as const,
        };
      }
      if (row.expires_at <= now) return { error: new OAuthError('invalid_grant', 'Refresh token expired after inactivity') };
      if (request.resource !== undefined && !resourceMatches(request.resource, row.resource)) {
        return { error: new OAuthError('invalid_target', 'resource does not match this server') };
      }
      let scope = row.scope;
      if (request.scope !== undefined) {
        // Narrowing only: a grant restricted to selected hosts never becomes a fleet-wide one (scopes.ts).
        const narrowed = narrowScopes(parseScope(row.scope) ?? [], parseScope(request.scope));
        if (!narrowed) return { error: new OAuthError('invalid_scope', 'Requested scope exceeds the original grant') };
        scope = formatScope(narrowed);
      }
      // A retry leaves the pairs already issued from this token alone: the client may have kept any of them.
      const isRetry = row.rotated_at !== null;
      if (!isRetry) {
        this.#db.prepare('UPDATE access_tokens SET revoked_at = ? WHERE refresh_token_hash = ? AND revoked_at IS NULL').run(now, row.token_hash);
        this.#db.prepare('UPDATE refresh_tokens SET rotated_at = ? WHERE token_hash = ?').run(now, row.token_hash);
        if (row.parent_hash !== null) {
          // The client settled on this token, so its siblings will not be used again.
          this.#db
            .prepare(
              `UPDATE refresh_tokens SET superseded_at = ?
                 WHERE parent_hash = ? AND token_hash != ? AND rotated_at IS NULL AND superseded_at IS NULL`,
            )
            .run(now, row.parent_hash, row.token_hash);
        }
      }
      const response = this.#issuePair(row.family_id, scope, now, row.token_hash);
      // Success is pair issuance in this transaction, including an accepted grace retry; never an attempted refresh.
      this.#db.prepare('UPDATE oauth_clients SET last_refresh_success_at = ? WHERE id = ?').run(now, row.client_id);
      const event: TokenEvent = isRetry
        ? { type: 'refresh_retry', clientId: row.client_id, familyId: row.family_id }
        : { type: 'issued', clientId: row.client_id, familyId: row.family_id, grant: 'refresh_token' };
      return { response, event };
    });
    if (outcome.event) this.#onEvent(outcome.event);
    if ('error' in outcome) throw outcome.error;
    return outcome.response;
  }

  /**
   * A bearer token the operator mints for an agent that cannot sign in with OAuth (`clients token`). It gets
   * a client of its own (no redirect URIs, so it can never complete an authorization; not counted toward the
   * registration limit) with one grant and one access token, and no refresh token: it works until it expires
   * or the client is revoked.
   */
  issueOperatorToken(input: { name: string; scopes: Scope[]; expiresAt: number }): { clientId: string; token: string; tokenId: string } {
    const token = randomToken();
    const clientId = randomId(12);
    const familyId = randomId(12);
    const scope = formatScope(input.scopes);
    const now = this.#clock();
    const tokenId = randomId(12);
    transaction(this.#db, () => {
      this.#db
        .prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at, counts_toward_limit) VALUES (?, ?, '[]', ?, 0)")
        .run(clientId, input.name, now);
      this.#db
        .prepare('INSERT INTO token_families (id, client_id, scope, resource, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(familyId, clientId, scope, this.#settings.resource, now);
      // refresh_token_hash cannot be NULL; an empty one matches no refresh token, so nothing ever rotates it.
      this.#db
        .prepare(
          `INSERT INTO access_tokens (token_hash, family_id, refresh_token_hash, scope, created_at, expires_at)
           VALUES (?, ?, '', ?, ?, ?)`,
        )
        .run(hashToken(token), familyId, scope, now, input.expiresAt);
      this.#db.prepare('INSERT INTO operator_tokens (id, token_hash) VALUES (?, ?)').run(tokenId, hashToken(token));
    });
    return { clientId, token, tokenId };
  }

  /** Rotate exactly one operator token; never extend its old expiry or change its grant. */
  rotateOperatorToken(clientId: string, tokenId: string, overlapMs: number, expiresAt: number): { tokenId: string; token: string } {
    const now = this.#clock();
    if (!Number.isSafeInteger(overlapMs) || overlapMs < 0 || overlapMs > 30 * DAY || !Number.isSafeInteger(expiresAt) || expiresAt <= now) {
      throw new GatewayError('invalid_argument', 'Overlap must be 0 to 30 days and the new expiry must be in the future.');
    }
    return transaction(this.#db, () => {
      const row = this.#db.prepare(`SELECT a.*, f.client_id, f.resource, f.revoked_at AS family_revoked_at,
        c.revoked_at AS client_revoked_at FROM operator_tokens o JOIN access_tokens a ON a.token_hash = o.token_hash
        JOIN token_families f ON f.id = a.family_id JOIN oauth_clients c ON c.id = f.client_id
        WHERE o.id = ? AND f.client_id = ?`).get(tokenId, clientId) as
        { token_hash: string; family_id: string; scope: string; expires_at: number; revoked_at: number | null;
          family_revoked_at: number | null; client_revoked_at: number | null; resource: string } | undefined;
      if (!row || !accessIsUsable(row, now, this.resource)) throw new GatewayError('not_found', 'No usable bearer token with that client and token id.');
      const token = randomToken();
      const nextId = randomId(12);
      this.#db.prepare('UPDATE access_tokens SET expires_at = MIN(expires_at, ?) WHERE token_hash = ?').run(now + overlapMs, row.token_hash);
      this.#db.prepare(`INSERT INTO access_tokens (token_hash, family_id, refresh_token_hash, scope, created_at, expires_at)
        VALUES (?, ?, '', ?, ?, ?)`).run(hashToken(token), row.family_id, row.scope, now, expiresAt);
      this.#db.prepare('INSERT INTO operator_tokens (id, token_hash) VALUES (?, ?)').run(nextId, hashToken(token));
      return { tokenId: nextId, token };
    });
  }

  /** Safe operator inventory: no hashes or secret material. Counts cover UTC hour buckets, including this hour. */
  operatorTokens(clientId: string): { id: string; createdAt: number; expiresAt: number; revoked: boolean;
    lastUsedAt: number | null; callsThisHour: number; calls24Hours: number }[] {
    const hour = Math.floor(this.#clock() / HOUR);
    return this.#db.prepare(`SELECT o.id, a.created_at AS createdAt, a.expires_at AS expiresAt,
      (a.revoked_at IS NOT NULL OR f.revoked_at IS NOT NULL OR c.revoked_at IS NOT NULL) AS revoked,
      o.last_used_at AS lastUsedAt,
      COALESCE((SELECT SUM(calls) FROM operator_token_calls WHERE token_id = o.id AND hour = ?), 0) AS callsThisHour,
      COALESCE((SELECT SUM(calls) FROM operator_token_calls WHERE token_id = o.id AND hour BETWEEN ? AND ?), 0) AS calls24Hours
      FROM operator_tokens o JOIN access_tokens a ON a.token_hash = o.token_hash
      JOIN token_families f ON f.id = a.family_id JOIN oauth_clients c ON c.id = f.client_id
      WHERE f.client_id = ? ORDER BY a.created_at, o.id`).all(hour, hour - 23, hour, clientId)
      .map((row) => ({ ...row, revoked: Boolean(row.revoked) })) as ReturnType<TokenService['operatorTokens']>;
  }

  revokeOperatorToken(clientId: string, tokenId: string): void {
    const result = this.#db.prepare(`UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash IN
      (SELECT o.token_hash FROM operator_tokens o JOIN access_tokens a ON a.token_hash = o.token_hash
       JOIN token_families f ON f.id = a.family_id WHERE o.id = ? AND f.client_id = ?)`).run(this.#clock(), tokenId, clientId);
    if (!result.changes) throw new GatewayError('not_found', 'No bearer token with that client and token id.');
  }

  /** Count authenticated, schema-valid tool invocations, including refused or failed calls; never protocol handshakes. */
  recordOperatorCall(tokenId: string): void {
    const now = this.#clock();
    const hour = Math.floor(now / HOUR);
    transaction(this.#db, () => {
      this.#db.prepare('UPDATE operator_tokens SET last_used_at = ? WHERE id = ?').run(now, tokenId);
      this.#db.prepare('DELETE FROM operator_token_calls WHERE hour < ?').run(hour - 23);
      this.#db.prepare(`INSERT INTO operator_token_calls (token_id, hour, calls) VALUES (?, ?, 1)
        ON CONFLICT (token_id, hour) DO UPDATE SET calls = calls + 1`).run(tokenId, hour);
    });
  }

  /** Returns the token's grant, or undefined when it is unknown, expired, revoked or for another resource. */
  verifyAccessToken(token: string): VerifiedAccessToken | undefined {
    const row = this.#db
      .prepare(
        `SELECT o.id AS operator_token_id, a.scope, a.expires_at, a.revoked_at, a.family_id, f.client_id, f.resource,
                f.revoked_at AS family_revoked_at, c.revoked_at AS client_revoked_at
           FROM access_tokens a JOIN token_families f ON f.id = a.family_id JOIN oauth_clients c ON c.id = f.client_id
           LEFT JOIN operator_tokens o ON o.token_hash = a.token_hash
           WHERE a.token_hash = ?`,
      )
      .get(hashToken(token)) as
      | {
          operator_token_id: string | null;
          scope: string;
          expires_at: number;
          revoked_at: number | null;
          family_id: string;
          client_id: string;
          resource: string;
          family_revoked_at: number | null;
          client_revoked_at: number | null;
        }
      | undefined;
    if (!row) return undefined;
    if (!accessIsUsable(row, this.#clock(), this.#settings.resource)) return undefined;
    return {
      ...(row.operator_token_id ? { operatorTokenId: row.operator_token_id } : {}),
      clientId: row.client_id,
      familyId: row.family_id,
      scopes: effectiveScopes(this.#db, row.client_id, parseScope(row.scope) ?? []),
      expiresAt: row.expires_at,
      resource: row.resource,
    };
  }

  #childWasRotated(tokenHash: string): boolean {
    return this.#db.prepare('SELECT 1 AS present FROM refresh_tokens WHERE parent_hash = ? AND rotated_at IS NOT NULL LIMIT 1').get(tokenHash) !== undefined;
  }

  #issuePair(familyId: string, scope: string, now: number, parentHash: string | null = null): TokenResponse {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessTtlMs = this.#settings.accessTtlSeconds * SECOND;
    this.#db
      .prepare('INSERT INTO refresh_tokens (token_hash, family_id, parent_hash, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hashToken(refreshToken), familyId, parentHash, scope, now, now + this.#settings.refreshIdleTtlDays * DAY);
    this.#db
      .prepare(
        `INSERT INTO access_tokens (token_hash, family_id, refresh_token_hash, scope, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(hashToken(accessToken), familyId, hashToken(refreshToken), scope, now, now + accessTtlMs);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.#settings.accessTtlSeconds,
      refresh_token: refreshToken,
      scope,
    };
  }

  #revokeFamily(familyId: string, reason: string, now: number): void {
    this.#db
      .prepare('UPDATE token_families SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now, reason, familyId);
  }
}
