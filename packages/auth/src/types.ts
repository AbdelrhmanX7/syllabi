import type { AxiosInstance } from 'axios';
import type { Socket } from 'socket.io-client';

// ---------------------------------------------------------------------------
// Base Types
// ---------------------------------------------------------------------------

export interface BaseUser {
  _id?: string;
}

// ---------------------------------------------------------------------------
// Auth Configuration
// ---------------------------------------------------------------------------

export interface AuthConfig<TUser extends BaseUser = BaseUser> {
  /** Role identifier (e.g., 'web', 'admin', 'teacher', 'studio') */
  role: string;

  /** Cookie key for the JWT token (e.g., 'token', 'admin_token') */
  cookieKey: string;

  /** localStorage key for the JWT token (usually matches cookieKey) */
  tokenStorageKey: string;

  /** localStorage key for the user data object */
  userStorageKey: string;

  /** Default empty user data object */
  defaultUserData: TUser;

  /**
   * Optional dynamic resolver for the axios `baseURL`. When provided, it is evaluated on
   * every request so the backend endpoint can be re-pointed at runtime (e.g. a cloud-sync
   * on/off switch) without rebuilding. Falls back to NEXT_PUBLIC_API when it returns falsy.
   */
  apiBaseUrl?: () => string | undefined;

  /**
   * Is this path readable without signing in?
   *
   * Consulted only by the API client's 401 handler, and only for a visitor who
   * had NO token to begin with: it suppresses the hard `window.location` bounce
   * to `/login` so a stray authenticated request cannot throw a guest off a page
   * the app publishes to strangers (the shared-assessment landing pages, the
   * marketing routes). An expired token still redirects — that visitor really
   * does have to sign in again.
   *
   * Receives a RESOLVED `window.location.pathname` (`/exam/t/AbC123/`), never a
   * Next route pattern (`/exam/t/[token]`).
   *
   * Omit it entirely in an app whose every page is behind auth (admin, teacher).
   */
  publicPathname?: (pathname: string) => boolean;

  /**
   * Signing in is a feature of this app, not a precondition for it.
   *
   * Consulted only by the API client's 401 handler. When true, a dead session is still
   * CLEARED (cookie + storage, so a stale token can't resurrect) but the hard
   * `window.location` bounce to `/login` is suppressed for everyone — guest or expired
   * session alike. For an offline-first app (the studio whiteboard) that redirect is the
   * app being yanked off a wall-mounted board mid-lesson because a background admin call
   * noticed the overnight JWT expired; the app's own UI offers sign-in where it matters.
   *
   * Omit everywhere sign-in is the front door (admin, teacher, web) — `publicPathname`
   * above is the narrow guest-only carve-out those apps want instead.
   */
  loginIsOptional?: boolean;

  /** Socket configuration (optional — apps without sockets omit this) */
  socket?: {
    /** Socket server URL or a function that resolves it */
    serverUrl: string | (() => string);
  };

  /** Service worker / push notification configuration */
  serviceWorker?: {
    /** VAPID public key value */
    vapidPublicKey: string | undefined;
    /** App identifier sent with push subscription (e.g., 'studio') */
    appIdentifier?: string;
  };

  /** Optional prefix for notification localStorage keys (e.g., 'studio') */
  notificationPrefix?: string;
}

// ---------------------------------------------------------------------------
// Hook Return Types
// ---------------------------------------------------------------------------

export interface AuthCookieReturn {
  setAuthToken: (token: string) => void;
  getAuthToken: () => string;
  removeAuthToken: () => Promise<void>;
}

export interface UserDataReturn<TUser extends BaseUser> {
  userData: TUser;
  token: string | undefined;
}

export interface AuthInitReturn {
  isLoading: boolean;
}

// ---------------------------------------------------------------------------
// Socket Types
// ---------------------------------------------------------------------------

export type SocketStatus = 'not_initialized' | 'connecting' | 'connected' | 'disconnected';

export interface SocketUtils {
  initSocket: (authToken?: string) => Promise<void>;
  getSocket: () => Socket | null;
  onSocketInitialized: (callback: () => void) => void;
  onSocketReconnect: (callback: () => void) => () => void;
  isSocketConnected: () => boolean;
  getSocketStatus: () => SocketStatus;
  disconnectSocket: () => void;
  removeUnloadListeners: () => void;
}

export interface SocketContextType {
  socket: Socket | null;
  isConnected: boolean;
  status: SocketStatus;
  connectionId: string | null;
}

// ---------------------------------------------------------------------------
// Notification Types
// ---------------------------------------------------------------------------

export interface NotificationPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  image?: string;
  url?: string;
  tag?: string;
  requireInteraction?: boolean;
  silent?: boolean;
  vibrate?: number[];
  actions?: Array<{
    action: string;
    title: string;
    icon?: string;
  }>;
  customData?: Record<string, any>;
}

export interface NotificationUtils {
  hasSeenNotificationModal: () => boolean;
  setNotificationModalShown: () => void;
  hasSeenSuccessModal: () => boolean;
  setSuccessModalShown: () => void;
  hasDismissedBanner: () => boolean;
  setBannerDismissed: () => void;
  hasGrantedPermission: () => boolean;
  setPermissionGranted: () => void;
  cleanupOldVersions: () => void;
  resetNotificationState: () => void;
  getNotificationDebugInfo: () => object;
  showLocalNotification: (payload: NotificationPayload) => void;
  testNotification: () => void;
  getServiceWorkerRegistration: () => Promise<ServiceWorkerRegistration | null>;
  getCurrentPushSubscription: () => Promise<PushSubscription | null>;
  unsubscribeFromPush: () => Promise<boolean>;
  initializePushNotifications: () => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Factory Input Types (for dependency injection)
// ---------------------------------------------------------------------------

export interface CreateAuthInitDeps {
  useAuthCookie: () => AuthCookieReturn;
  useGetUserData: () => UserDataReturn<any>;
  apiClient?: AxiosInstance;
  socketUtils?: SocketUtils;
}
