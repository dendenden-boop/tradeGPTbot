export {
  createAuthService,
  AuthError,
  isOpaqueToken,
  normalizeEmail,
  validatePassword,
} from './service.js';
export type {
  AuthContext,
  AuthErrorCode,
  AuthService,
  AuthServiceOptions,
  AuthSession,
} from './service.js';
export * from './password.js';
export * from './mail.js';
export * from './rate-limit.js';
