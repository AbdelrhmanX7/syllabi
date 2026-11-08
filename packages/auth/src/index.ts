// Types
export type {
  AuthConfig,
  BaseUser,
  AuthCookieReturn,
  UserDataReturn,
  AuthInitReturn,
  SocketStatus,
  SocketUtils,
  SocketContextType,
  NotificationPayload,
  NotificationUtils,
  CreateAuthInitDeps,
} from './types';

// Factories
export { createAuthCookie } from './create-auth-cookie';
export { createGetUserData } from './create-user-data';
export { createApiClient } from './create-api-client';
export { createSocket } from './create-socket';
export { createSocketContext } from './create-socket-context';
export { createServiceWorker } from './create-service-worker';
export { createAuthInit } from './create-auth-init';
export { createNotificationPermission } from './create-notification-permission';

// Notification utilities
export {
  createNotificationUtils,
  isIOSDevice,
  isIOSPWA,
  isNotificationSupported,
  getNotificationPermission,
  requestNotificationPermission,
  NOTIFICATION_VERSION,
} from './notifications';
