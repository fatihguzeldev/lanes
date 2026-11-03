import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDatabase } from '../../../tests/sqlite-d1';
import { decryptToken, encryptToken } from './crypto';
import { GOOGLE_TASKS_SCOPE, GoogleOAuthError } from './google';
import type { GoogleGrant } from './google';
import { accountGrantContext } from './server';
import type { AccountConfig } from './server';
import { ProviderAccess } from './provider-access';

const initialNow = Date.parse('2026-11-02T12:00:00Z');
const config: AccountConfig = {
  origin: 'https://lanes.example',
  ownerEmail: 'owner@example.com',
  sessionKey: Buffer.alloc(32, 1).toString('base64url'),
  tokenKey: { id: 'key-1', value: Buffer.alloc(32, 2).toString('base64url') },
  google: {
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'https://lanes.example/auth/google/callback',
  },
};
const grant = (extra: Partial<GoogleGrant> = {}): GoogleGrant => ({
  accessToken: 'access-original',
  refreshToken: 'refresh-original',
  expiresAt: initialNow + 3600_000,
  scopes: [GOOGLE_TASKS_SCOPE],
  tokenType: 'Bearer',
  ...extra,
});
const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});
async function fixture(value = grant()) {
  const database = testDatabase();
  closes.push(database.close);
  await database.db
    .prepare(
      `INSERT INTO accounts_installation (id,owner_subject,bootstrap_email,owner_generation,token_key_id,created_at) VALUES (1,'owner-subject',?,'generation',?,?)`,
    )
    .bind(config.ownerEmail, config.tokenKey.id, initialNow)
    .run();
  const cipher = await encryptToken(
    JSON.stringify(value),
    config.tokenKey,
    accountGrantContext('account-a'),
  );
  await database.db
    .prepare(
      `INSERT INTO accounts_connections (id,google_subject,email,display_name,state,grant_ciphertext,scopes_json,access_expires_at,grant_expires_at,created_at,updated_at) VALUES ('account-a','subject-a','a@example.com','a','connected',?,?,?,?,?,?)`,
    )
    .bind(
      cipher,
      JSON.stringify(value.scopes),
      value.expiresAt,
      initialNow + 7 * 86_400_000,
      initialNow,
      initialNow,
    )
    .run();
  let now = initialNow;
  return {
    ...database,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    row: () =>
      database.db
        .prepare('SELECT * FROM accounts_connections WHERE id=?')
        .bind('account-a')
        .first<Record<string, unknown>>(),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('server-managed provider tokens', () => {
  it('uses a cached token and permits initial inventory while connecting', async () => {
    const f = await fixture();
    const refresh = vi.fn();
    const api = new ProviderAccess(f.db, config, { now: f.now, refresh });
    expect(await api.getAccessToken('account-a')).toEqual({
      accessToken: 'access-original',
      tokenRevision: 0,
    });
    await f.db.prepare("UPDATE accounts_connections SET state='connecting'").run();
    expect((await api.getAccessToken('account-a')).accessToken).toBe('access-original');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps the seven-day consent deadline separate from a valid access token', async () => {
    const f = await fixture(grant({ expiresAt: initialNow + 10 * 86_400_000 }));
    f.advance(7 * 86_400_000);
    await expect(
      new ProviderAccess(f.db, config, { now: f.now }).getAccessToken('account-a'),
    ).rejects.toMatchObject({ code: 'reconnect_required' });
    expect((await f.row())?.grant_ciphertext).toBeTruthy();
  });

  it('fails closed for encryption or owner configuration without deleting credentials', async () => {
    const f = await fixture();
    const before = await f.row();
    for (const changed of [
      { ...config, tokenKey: { ...config.tokenKey, id: 'key-2' } },
      {
        ...config,
        tokenKey: { ...config.tokenKey, value: Buffer.alloc(32, 3).toString('base64url') },
      },
      { ...config, ownerEmail: 'changed@example.com' },
    ]) {
      await expect(
        new ProviderAccess(f.db, changed, { now: f.now }).getAccessToken('account-a'),
      ).rejects.toMatchObject({ code: 'installation_unavailable' });
    }
    expect((await f.row())?.grant_ciphertext).toBe(before?.grant_ciphertext);
    expect((await f.row())?.state).toBe('connected');
  });

  it('serializes refresh with a durable claim and lets a loser reread the winner', async () => {
    const f = await fixture(grant({ expiresAt: initialNow + 30_000 }));
    const started = deferred<void>(),
      result = deferred<GoogleGrant>();
    const refresh = vi.fn(async () => {
      started.resolve();
      return result.promise;
    });
    const a = new ProviderAccess(f.db, config, { now: f.now, refresh });
    const first = a.getAccessToken('account-a');
    await started.promise;
    await expect(
      new ProviderAccess(f.db, config, { now: f.now, refresh }).getAccessToken('account-a'),
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    result.resolve(grant({ accessToken: 'fresh-access' }));
    expect(await first).toEqual({ accessToken: 'fresh-access', tokenRevision: 1 });
    expect((await a.getAccessToken('account-a')).accessToken).toBe('fresh-access');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('fences a late refresh after a relink advances the token revision', async () => {
    const f = await fixture(grant({ expiresAt: initialNow }));
    const started = deferred<void>(),
      result = deferred<GoogleGrant>();
    const api = new ProviderAccess(f.db, config, {
      now: f.now,
      refresh: async () => {
        started.resolve();
        return result.promise;
      },
    });
    const pending = api.getAccessToken('account-a');
    await started.promise;
    const newGrant = grant({ accessToken: 'new-link-token', refreshToken: 'new-link-refresh' });
    const cipher = await encryptToken(
      JSON.stringify(newGrant),
      config.tokenKey,
      accountGrantContext('account-a'),
    );
    await f.db
      .prepare(
        'UPDATE accounts_connections SET token_revision=token_revision+1,grant_ciphertext=?,access_expires_at=?,refresh_claim=NULL,refresh_claim_until=NULL',
      )
      .bind(cipher, newGrant.expiresAt)
      .run();
    result.resolve(grant({ accessToken: 'late-old-refresh' }));
    expect(await pending).toEqual({ accessToken: 'new-link-token', tokenRevision: 1 });
    expect((await f.row())?.grant_ciphertext).toBe(cipher);
  });

  it('does not mark a relinked account expired when an older refresh returns invalid_grant', async () => {
    const f = await fixture(grant({ expiresAt: initialNow }));
    const started = deferred<void>(),
      finished = deferred<void>();
    const pending = new ProviderAccess(f.db, config, {
      now: f.now,
      refresh: async () => {
        started.resolve();
        await finished.promise;
        throw new GoogleOAuthError('reconnect_required');
      },
    }).getAccessToken('account-a');
    await started.promise;
    const linked = grant({ accessToken: 'newly-linked' });
    const cipher = await encryptToken(
      JSON.stringify(linked),
      config.tokenKey,
      accountGrantContext('account-a'),
    );
    await f.db
      .prepare(
        'UPDATE accounts_connections SET token_revision=token_revision+1,grant_ciphertext=?,access_expires_at=?,refresh_claim=NULL,refresh_claim_until=NULL',
      )
      .bind(cipher, linked.expiresAt)
      .run();
    finished.resolve();
    expect((await pending).accessToken).toBe('newly-linked');
    expect((await f.row())?.state).toBe('connected');
  });

  it('does not return a refreshed token after consent expires during the request', async () => {
    const f = await fixture(grant({ expiresAt: initialNow }));
    await f.db
      .prepare('UPDATE accounts_connections SET grant_expires_at=?')
      .bind(initialNow + 1000)
      .run();
    const api = new ProviderAccess(f.db, config, {
      now: f.now,
      refresh: async () => {
        f.advance(1001);
        return grant({ accessToken: 'too-late' });
      },
    });
    await expect(api.getAccessToken('account-a')).rejects.toMatchObject({
      code: 'reconnect_required',
    });
    expect((await f.row())?.state).toBe('reconnect_required');
    expect((await f.row())?.refresh_claim).toBeNull();
  });

  it('rejects an installation generation change while refresh is in flight', async () => {
    const f = await fixture(grant({ expiresAt: initialNow }));
    const started = deferred<void>(),
      result = deferred<GoogleGrant>();
    const before = await f.row();
    const pending = new ProviderAccess(f.db, config, {
      now: f.now,
      refresh: async () => {
        started.resolve();
        return result.promise;
      },
    }).getAccessToken('account-a');
    await started.promise;
    await f.db.prepare("UPDATE accounts_installation SET owner_generation='replacement'").run();
    result.resolve(grant({ accessToken: 'old-generation-result' }));
    await expect(pending).rejects.toMatchObject({ code: 'installation_unavailable' });
    expect((await f.row())?.grant_ciphertext).toBe(before?.grant_ciphertext);
    expect((await f.row())?.state).toBe('connected');
  });

  it('does not let an expired lease overwrite a competing refresh result', async () => {
    const f = await fixture(grant({ expiresAt: initialNow }));
    const started = deferred<void>(),
      result = deferred<GoogleGrant>();
    const first = new ProviderAccess(f.db, config, {
      now: f.now,
      refresh: async () => {
        started.resolve();
        return result.promise;
      },
    }).getAccessToken('account-a');
    await started.promise;
    f.advance(30_001);
    const second = new ProviderAccess(f.db, config, {
      now: f.now,
      refresh: async () => grant({ accessToken: 'winner-token' }),
    });
    expect((await second.getAccessToken('account-a')).tokenRevision).toBe(1);
    result.resolve(grant({ accessToken: 'late-token' }));
    expect(await first).toEqual({ accessToken: 'winner-token', tokenRevision: 1 });
  });

  it('refreshes an observed rejected token version only once', async () => {
    const f = await fixture();
    const refresh = vi.fn(async () => grant({ accessToken: 'refreshed-once' }));
    const api = new ProviderAccess(f.db, config, { now: f.now, refresh });
    expect(
      (await api.getAccessToken('account-a', { forceRefresh: true, observedTokenRevision: 0 }))
        .tokenRevision,
    ).toBe(1);
    expect(
      (await api.getAccessToken('account-a', { forceRefresh: true, observedTokenRevision: 0 }))
        .accessToken,
    ).toBe('refreshed-once');
    expect(refresh).toHaveBeenCalledTimes(1);
    await expect(api.getAccessToken('account-a', { forceRefresh: true })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('preserves the existing refresh token and deadline when refresh returns no replacement', async () => {
    const f = await fixture(grant({ expiresAt: initialNow }));
    const api = new ProviderAccess(f.db, config, {
      now: f.now,
      refresh: async () => grant({ refreshToken: null, accessToken: 'fresh' }),
    });
    await api.getAccessToken('account-a');
    const row = await f.row();
    const saved = JSON.parse(
      await decryptToken(
        String(row?.grant_ciphertext),
        config.tokenKey,
        accountGrantContext('account-a'),
      ),
    ) as GoogleGrant;
    expect(saved.refreshToken).toBe('refresh-original');
    expect(row?.grant_expires_at).toBe(initialNow + 7 * 86_400_000);
  });

  it('marks invalid_grant for reconnect but preserves an outage as a retryable provider failure', async () => {
    for (const code of [
      'reconnect_required',
      'provider_unavailable',
      'provider_rate_limited',
    ] as const) {
      const f = await fixture(grant({ expiresAt: initialNow }));
      const before = await f.row();
      const api = new ProviderAccess(f.db, config, {
        now: f.now,
        refresh: async () => {
          throw new GoogleOAuthError(code, code !== 'reconnect_required');
        },
      });
      await expect(api.getAccessToken('account-a')).rejects.toMatchObject({ code });
      expect((await f.row())?.state).toBe(
        code === 'reconnect_required' ? 'reconnect_required' : 'connected',
      );
      expect((await f.row())?.grant_ciphertext).toBe(before?.grant_ciphertext);
      expect((await f.row())?.refresh_claim).toBeNull();
    }
  });

  it('keeps optional permission denial separate from task access', async () => {
    const f = await fixture();
    const api = new ProviderAccess(f.db, config, { now: f.now });
    await expect(
      api.getAccessToken('account-a', {
        requiredScopes: ['https://www.googleapis.com/auth/drive.file'],
      }),
    ).rejects.toMatchObject({ code: 'permission_required' });
    expect((await api.getAccessToken('account-a')).accessToken).toBe('access-original');
    expect((await f.row())?.state).toBe('connected');
  });

  it('promotes only a connecting account after its owner confirms workspace initialization', async () => {
    const f = await fixture();
    const api = new ProviderAccess(f.db, config, { now: f.now });
    await f.db.prepare("UPDATE accounts_connections SET state='connecting'").run();
    expect(await api.markWorkspaceInitialized('account-a')).toBe(true);
    expect((await f.row())?.state).toBe('connected');
    await api.requestDisconnect('account-a');
    expect(await api.markWorkspaceInitialized('account-a')).toBe(false);
  });
});

describe('disconnect settlement', () => {
  it('invalidates targeted and generic link oauth states, including consumed callbacks', async () => {
    const f = await fixture();
    for (const [hash, purpose, account, consumed] of [
      ['target', 'reconnect', 'account-a', initialNow],
      ['generic', 'link', null, initialNow],
      ['signin', 'signin', null, null],
    ] as const) {
      await f.db
        .prepare(
          `INSERT INTO accounts_oauth_states (state_hash,browser_hash,purpose,account_id,verifier_ciphertext,nonce,return_path,planning_zone,expires_at,consumed_at,created_at) VALUES (?,'browser',?,?,'cipher','nonce','/','UTC',?,?,?)`,
        )
        .bind(hash, purpose, account, initialNow + 600_000, consumed, initialNow)
        .run();
    }
    const api = new ProviderAccess(f.db, config, { now: f.now });
    expect((await api.requestDisconnect('account-a')).pending).toBe(true);
    expect(
      (
        await f.db
          .prepare('SELECT state_hash FROM accounts_oauth_states')
          .all<{ state_hash: string }>()
      ).results.map((row) => row.state_hash),
    ).toEqual(['signin']);
    expect((await f.row())?.token_revision).toBe(1);
    await expect(api.getAccessToken('account-a')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('waits for issued owner work and does not revoke before settlement', async () => {
    const f = await fixture();
    let pending = true;
    const revoke = vi.fn(async () => {});
    const api = new ProviderAccess(f.db, config, {
      now: f.now,
      revoke,
      pendingProviderWork: async () => pending,
    });
    await api.requestDisconnect('account-a');
    expect((await api.finalizeDisconnect('account-a')).pending).toBe(true);
    expect(revoke).not.toHaveBeenCalled();
    pending = false;
    expect(await api.finalizeDisconnect('account-a')).toMatchObject({
      state: 'disconnected',
      pending: false,
      remoteRevocation: 'succeeded',
    });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect((await f.row())?.grant_ciphertext).toBeNull();
  });

  it('waits for its refresh lease and rejects the late refreshed token after disconnect', async () => {
    const f = await fixture(grant({ expiresAt: initialNow }));
    const started = deferred<void>(),
      result = deferred<GoogleGrant>();
    const revoke = vi.fn(async () => {});
    const api = new ProviderAccess(f.db, config, {
      now: f.now,
      revoke,
      refresh: async () => {
        started.resolve();
        return result.promise;
      },
    });
    const pending = api.getAccessToken('account-a');
    await started.promise;
    await api.requestDisconnect('account-a');
    expect((await api.finalizeDisconnect('account-a')).pending).toBe(true);
    expect(revoke).not.toHaveBeenCalled();
    result.resolve(grant({ accessToken: 'late-refresh' }));
    await expect(pending).rejects.toMatchObject({ code: 'conflict' });
    expect(await api.finalizeDisconnect('account-a')).toMatchObject({
      state: 'disconnected',
      remoteRevocation: 'succeeded',
    });
  });

  it('removes the local grant even when remote revocation fails, without claiming remote success', async () => {
    const f = await fixture();
    const api = new ProviderAccess(f.db, config, {
      now: f.now,
      revoke: async () => {
        throw new Error('private provider body');
      },
    });
    await api.requestDisconnect('account-a');
    expect(await api.finalizeDisconnect('account-a')).toEqual({
      state: 'disconnected',
      pending: false,
      remoteRevocation: 'failed',
    });
    const row = await f.row();
    expect(row?.grant_ciphertext).toBeNull();
    expect(row?.scopes_json).toBe('[]');
    expect(row?.token_revision).toBe(2);
    await expect(api.getAccessToken('account-a')).rejects.toMatchObject({
      code: 'reconnect_required',
    });
  });

  it('keeps an unreadable encrypted grant in disconnecting state for configuration repair', async () => {
    const f = await fixture();
    const api = new ProviderAccess(f.db, config, { now: f.now });
    await api.requestDisconnect('account-a');
    const before = await f.row();
    const wrong = new ProviderAccess(
      f.db,
      {
        ...config,
        tokenKey: { ...config.tokenKey, value: Buffer.alloc(32, 9).toString('base64url') },
      },
      { now: f.now },
    );
    await expect(wrong.finalizeDisconnect('account-a')).rejects.toMatchObject({
      code: 'installation_unavailable',
    });
    expect((await f.row())?.grant_ciphertext).toBe(before?.grant_ciphertext);
    expect((await f.row())?.state).toBe('disconnecting');
    expect((await f.row())?.work_claim).toBeNull();
  });

  it('serializes competing revocation finalizers without duplicating a live attempt', async () => {
    const f = await fixture();
    const started = deferred<void>(),
      done = deferred<void>();
    const revoke = vi.fn(async () => {
      started.resolve();
      await done.promise;
    });
    const api = new ProviderAccess(f.db, config, { now: f.now, revoke });
    await api.requestDisconnect('account-a');
    const first = api.finalizeDisconnect('account-a');
    await started.promise;
    expect((await api.finalizeDisconnect('account-a')).pending).toBe(true);
    done.resolve();
    expect((await first).remoteRevocation).toBe('succeeded');
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
