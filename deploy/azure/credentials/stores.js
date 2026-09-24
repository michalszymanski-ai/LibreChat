/**
 * Every MongoDB location LibreChat v0.8.8-rc4 encrypts with CREDS_KEY/CREDS_IV. Values that fail
 * to decrypt here fail the run; `rotate.js` additionally sweeps all other collections for v2/v3
 * shaped strings so a location added upstream later is still rotated.
 *
 * `fields` are dot-paths; `scan: true` walks the whole document instead.
 */
const stores = [
  /** packages/data-schemas/src/methods/key.ts: user-provided endpoint keys. */
  { collection: 'keys', fields: ['value'], versions: ['v1'], validate: 'text' },
  /** api/server/services/PluginService.js, packages/api/src/agents/auth.ts: tool and MCP user vars. */
  { collection: 'pluginauths', fields: ['value'], versions: ['v1'], validate: 'text' },
  /**
   * packages/api/src/mcp/oauth/tokens.ts, packages/api/src/oauth/tokens.ts: MCP and action OAuth
   * access/refresh tokens and client registrations. Email/reset tokens in the same collection are
   * bcrypt hashes, which never match the v2 shape.
   */
  { collection: 'tokens', fields: ['token'], versions: ['v2'], validate: 'text' },
  /** api/server/controllers/TwoFactorController.js writes v3; older enrollments are v2. */
  { collection: 'users', fields: ['totpSecret'], versions: ['v3', 'v2'], validate: 'base32' },
  /** packages/api/src/actions/crypto.ts via api/server/services/ActionService.js. */
  {
    collection: 'actions',
    fields: ['metadata.api_key', 'metadata.oauth_client_id', 'metadata.oauth_client_secret'],
    versions: ['v2'],
    validate: 'text',
  },
  /** packages/data-schemas/src/methods/skillSync.ts. */
  {
    collection: 'skillsynccredentials',
    fields: ['encryptedToken'],
    versions: ['v2'],
    validate: 'text',
  },
  /** packages/api/src/mcp/registry/db/ServerConfigsDB.ts: admin API keys and OAuth client secrets. */
  {
    collection: 'mcpservers',
    fields: ['config.apiKey.key', 'config.oauth.client_secret'],
    versions: ['v2'],
    validate: 'text',
  },
  /** packages/api/src/admin/secrets.ts: registered and array (`endpoints.custom[*]`) secrets. */
  { collection: 'configs', scan: true, versions: ['v3'], validate: 'text' },
  /** packages/api/src/auth/openid/flight.ts: short-lived OpenID refresh results. */
  {
    collection: 'openidrefreshflights',
    fields: ['encryptedResult'],
    versions: ['v1'],
    validate: 'json',
  },
  /** packages/api/src/auth/openid/bridge.ts: short-lived refresh-token bridges. */
  {
    collection: 'refreshtokenbridges',
    fields: ['encryptedNewRefreshToken'],
    versions: ['v1'],
    validate: 'text',
  },
];

/** Collections never swept: the drift marker itself and MongoDB internals. */
const sweepExclusions = new Set(['librechatCredentialMetadata']);

module.exports = { stores, sweepExclusions };
