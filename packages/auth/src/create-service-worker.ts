import { useState } from 'react';
import axios from 'axios';
import { getCookie } from 'cookies-next';

import { isIOSDevice, isIOSPWA } from './notifications';
import type { AuthConfig } from './types';

export function createServiceWorker(config: AuthConfig) {
  const useServiceWorker = () => {
    const [isInitialized, setIsInitialized] = useState(false);

    // Service worker initialization function
    const initializeServiceWorker = async () => {
      // Block service worker initialization on iOS devices unless in PWA mode
      if (isIOSDevice() && !isIOSPWA()) {
        return false;
      }

      const token = getCookie(config.cookieKey);

      if (!token) {
        // No token found

        return false;
      }

      // Check if already initialized
      if (isInitialized) {
        // Service worker already initialized

        return true;
      }

      try {
        // Register service worker
        const register = await navigator.serviceWorker.register('/note-sw.js');

        // Service Worker registered successfully

        // Wait for service worker to be ready
        await navigator.serviceWorker.ready;

        // Send auth token and API URL to service worker for notification click tracking
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: 'SET_TOKEN',
            token: token,
          });

          navigator.serviceWorker.controller.postMessage({
            type: 'SET_API_URL',
            url: process.env.NEXT_PUBLIC_API,
          });
        }

        // Check if push manager is available
        if (!register.pushManager) {
          // Push manager unavailable

          return false;
        }

        // Check for existing subscription
        let subscription = await register.pushManager.getSubscription();

        if (!subscription) {
          // Create new subscription
          const vapidPublicKey = config.serviceWorker?.vapidPublicKey;

          if (!vapidPublicKey) {
            // VAPID public key not found

            return false;
          }

          // Convert VAPID key for iOS compatibility
          const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);

          subscription = await register.pushManager.subscribe({
            applicationServerKey,
            userVisibleOnly: true,
          });
        }

        // Build subscription body, optionally including app identifier
        const subscriptionBody = config.serviceWorker?.appIdentifier
          ? { ...subscription.toJSON(), appIdentifier: config.serviceWorker.appIdentifier }
          : subscription;

        // Send subscription to server with auth token
        const res = await axios.post('/notifications/subscribe-push', subscriptionBody, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });

        if (res.status !== 200 && res.status !== 201) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }

        // Subscription response ok
        setIsInitialized(true);

        return true;
      } catch {
        // Service Worker registration failed

        return false;
      }
    };

    // Helper function to convert VAPID key
    const urlBase64ToUint8Array = (base64String: string) => {
      const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');

      const rawData = window.atob(base64);
      const outputArray = new Uint8Array(rawData.length);

      for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
      }

      return outputArray;
    };

    // Note: Initialization is now controlled externally to avoid side-effects
    // that might interfere with UI scroll state. We intentionally removed
    // auto-initialization and permission listeners here.

    return {
      initializeServiceWorker,
      isInitialized,
    };
  };

  return useServiceWorker;
}
