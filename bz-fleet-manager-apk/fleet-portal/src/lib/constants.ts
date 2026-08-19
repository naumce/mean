// Shared localStorage key for the dispatcher access token. Used by both the
// auth store (writer) and the api client (reader), kept in one place so the
// two never drift apart.
export const TOKEN_STORAGE_KEY = 'fleet_token'
