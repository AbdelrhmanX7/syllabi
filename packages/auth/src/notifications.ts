// Configurable notification utilities with optional prefix for localStorage keys

import type { NotificationPayload, NotificationUtils } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Notification system version - increment this to re-show notification prompts to all users
 * Current version: 2 (Reset all user notification permissions)
 */
export const NOTIFICATION_VERSION = 2;

// ---------------------------------------------------------------------------
// Pure detection functions (no config needed)
// ---------------------------------------------------------------------------

/**
 * Check if we're on an iOS device
 */
export const isIOSDevice = (): boolean => {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
};

/**
 * Check if the app is running in PWA/standalone mode on iOS
 */
export const isIOSPWA = (): boolean => {
  const isIOS = isIOSDevice();
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
  const isWebAppCapable = (window.navigator as any).standalone === true;

  return isIOS && (isStandalone || isWebAppCapable);
};

/**
 * Check if notifications are supported in the browser
 * iOS supports notifications only in PWA/standalone mode (iOS 16.4+)
 */
export const isNotificationSupported = (): boolean => {
  // Check if we're on iOS
  if (isIOSDevice()) {
    // iOS only supports notifications in PWA mode
    if (!isIOSPWA()) {
      return false;
    }
  }

  return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
};

/**
 * Get current notification permission status
 */
export const getNotificationPermission = (): NotificationPermission => {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'default';
  }

  return Notification.permission;
};

/**
 * Request notification permission from user
 */
export const requestNotificationPermission = async (): Promise<NotificationPermission> => {
  // Block permission request on iOS devices unless in PWA mode
  if (isIOSDevice() && !isIOSPWA()) {
    return 'denied';
  }

  if (!isNotificationSupported()) {
    throw new Error('Notifications are not supported in this browser');
  }

  return await Notification.requestPermission();
};

// ---------------------------------------------------------------------------
// Factory for localStorage-dependent functions
// ---------------------------------------------------------------------------

/**
 * Create notification utilities with an optional prefix for localStorage keys.
 * - When prefix is undefined: keys are `notification-permission-shown-v2` (default)
 * - When prefix is `'studio'`: keys are `studio-notification-permission-shown-v2`
 */
export function createNotificationUtils(prefix?: string, cookieKey?: string): NotificationUtils {
  /**
   * Get versioned localStorage key with optional prefix
   */
  const getVersionedKey = (key: string): string => {
    return `${prefix ? prefix + '-' : ''}${key}-v${NOTIFICATION_VERSION}`;
  };

  /**
   * Get the base keys used for cleanup
   */
  const getBaseKeys = (): string[] => {
    const basePrefix = prefix ? prefix + '-' : '';

    return [
      `${basePrefix}notification-permission-shown`,
      `${basePrefix}notification-permission-granted`,
      `${basePrefix}notification-banner-dismissed`,
      `${basePrefix}notification-success-shown`,
    ];
  };

  // -- localStorage state functions --

  const hasSeenNotificationModal = (): boolean => {
    return localStorage.getItem(getVersionedKey('notification-permission-shown')) === 'true';
  };

  const setNotificationModalShown = (): void => {
    localStorage.setItem(getVersionedKey('notification-permission-shown'), 'true');
  };

  const hasSeenSuccessModal = (): boolean => {
    return localStorage.getItem(getVersionedKey('notification-success-shown')) === 'true';
  };

  const setSuccessModalShown = (): void => {
    localStorage.setItem(getVersionedKey('notification-success-shown'), 'true');
  };

  const hasDismissedBanner = (): boolean => {
    return localStorage.getItem(getVersionedKey('notification-banner-dismissed')) === 'true';
  };

  const setBannerDismissed = (): void => {
    localStorage.setItem(getVersionedKey('notification-banner-dismissed'), 'true');
  };

  const hasGrantedPermission = (): boolean => {
    return localStorage.getItem(getVersionedKey('notification-permission-granted')) === 'true';
  };

  const setPermissionGranted = (): void => {
    localStorage.setItem(getVersionedKey('notification-permission-granted'), 'true');
  };

  const cleanupOldVersions = (): void => {
    const keys = getBaseKeys();

    // Remove non-versioned keys
    keys.forEach((key) => {
      localStorage.removeItem(key);
    });

    // Remove old versioned keys
    for (let v = 1; v < NOTIFICATION_VERSION; v++) {
      keys.forEach((key) => {
        localStorage.removeItem(`${key}-v${v}`);
      });
    }
  };

  const resetNotificationState = (): void => {
    const keys = getBaseKeys();

    // Remove non-versioned keys
    keys.forEach((key) => {
      localStorage.removeItem(key);
    });

    // Remove all versioned keys
    for (let v = 1; v <= NOTIFICATION_VERSION; v++) {
      keys.forEach((key) => {
        localStorage.removeItem(`${key}-v${v}`);
      });
    }

    console.log('Notification state reset');
  };

  const getNotificationDebugInfo = () => {
    return {
      version: NOTIFICATION_VERSION,
      prefix: prefix || null,
      isSupported: isNotificationSupported(),
      permission: getNotificationPermission(),
      hasSeenModal: hasSeenNotificationModal(),
      hasGranted: hasGrantedPermission(),
      hasDismissedBanner: hasDismissedBanner(),
    };
  };

  // -- Notification display functions --

  const showLocalNotification = (payload: NotificationPayload): void => {
    if (!isNotificationSupported() || Notification.permission !== 'granted') {
      console.log('Cannot show notification: permission not granted or not supported');

      return;
    }

    try {
      const notification = new Notification(payload.title, {
        body: payload.body,
        icon: payload.icon || '/icon-192x192.png',
        badge: payload.badge || '/icon-96x96.png',
        tag: payload.tag || 'local-notification',
        requireInteraction: payload.requireInteraction || false,
        silent: payload.silent || false,
        data: {
          url: payload.url || '/',
          ...payload.customData,
        },
      });

      // Handle notification click
      notification.onclick = (event) => {
        event.preventDefault();
        notification.close();

        if (payload.url) {
          window.open(payload.url, '_blank');
        }
      };

      // Auto close after 5 seconds if not requireInteraction
      if (!payload.requireInteraction) {
        setTimeout(() => {
          notification.close();
        }, 5000);
      }
    } catch (error) {
      // Some mobile browsers don't support the Notification constructor
      // even when permission is granted (e.g., "Illegal constructor" error)
      // In these cases, ServiceWorkerRegistration.showNotification() should be used instead
      console.log('Could not show notification:', error);
    }
  };

  const testNotification = (): void => {
    showLocalNotification({
      title: 'Syllabi - test notification',
      body: 'This is a test notification to check that notifications work.',
      icon: '/icon-192x192.png',
      badge: '/icon-96x96.png',
      url: '/',
      tag: 'test-notification',
      vibrate: [200, 100, 200, 100, 200],
      actions: [
        {
          action: 'open',
          title: 'Open app',
        },
        {
          action: 'close',
          title: 'Close',
        },
      ],
    });
  };

  // -- Service worker / push functions --

  const getServiceWorkerRegistration = async (): Promise<ServiceWorkerRegistration | null> => {
    if (!('serviceWorker' in navigator)) {
      return null;
    }

    try {
      const registration = await navigator.serviceWorker.getRegistration();

      return registration || null;
    } catch (error) {
      console.log('Error getting service worker registration:', error);

      return null;
    }
  };

  const getCurrentPushSubscription = async (): Promise<PushSubscription | null> => {
    const registration = await getServiceWorkerRegistration();

    if (!registration || !registration.pushManager) {
      return null;
    }

    try {
      return await registration.pushManager.getSubscription();
    } catch (error) {
      console.log('Error getting push subscription:', error);

      return null;
    }
  };

  const unsubscribeFromPush = async (): Promise<boolean> => {
    const subscription = await getCurrentPushSubscription();

    if (!subscription) {
      return true;
    }

    try {
      return await subscription.unsubscribe();
    } catch (error) {
      console.log('Error unsubscribing from push:', error);

      return false;
    }
  };

  const initializePushNotifications = async (): Promise<boolean> => {
    // Block initialization on iOS devices unless in PWA mode
    if (isIOSDevice() && !isIOSPWA()) {
      return false;
    }

    if (!isNotificationSupported()) {
      console.log('Push notifications not supported');

      return false;
    }

    if (getNotificationPermission() !== 'granted') {
      console.log('Notification permission not granted');

      return false;
    }

    try {
      // Register service worker
      const registration = await navigator.serviceWorker.register('/note-sw.js');

      console.log('Service Worker registered successfully:', registration);

      // Wait for service worker to be ready
      await navigator.serviceWorker.ready;

      // Check if push manager is available
      if (!registration.pushManager) {
        console.log('Push manager unavailable');

        return false;
      }

      // Check for existing subscription
      let subscription = await registration.pushManager.getSubscription();

      if (!subscription) {
        // Create new subscription
        const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

        if (!vapidPublicKey) {
          console.log('VAPID public key not found in environment variables');

          return false;
        }

        subscription = await registration.pushManager.subscribe({
          applicationServerKey: vapidPublicKey,
          userVisibleOnly: true,
        });
      }

      // Send subscription to server
      const response = await fetch(`${process.env.NEXT_PUBLIC_API}/notifications/subscribe-push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${document.cookie.match(new RegExp(`(?:^|;\\s*)${cookieKey || 'token'}=([^;]+)`))?.[1] || ''}`,
        },
        body: JSON.stringify(subscription),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      console.log('Push notification subscription successful');

      return true;
    } catch (error) {
      console.log('Error initializing push notifications:', error);

      return false;
    }
  };

  return {
    hasSeenNotificationModal,
    setNotificationModalShown,
    hasSeenSuccessModal,
    setSuccessModalShown,
    hasDismissedBanner,
    setBannerDismissed,
    hasGrantedPermission,
    setPermissionGranted,
    cleanupOldVersions,
    resetNotificationState,
    getNotificationDebugInfo,
    showLocalNotification,
    testNotification,
    getServiceWorkerRegistration,
    getCurrentPushSubscription,
    unsubscribeFromPush,
    initializePushNotifications,
  };
}
