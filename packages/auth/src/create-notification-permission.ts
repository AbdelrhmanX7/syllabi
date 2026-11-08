import { getCookie } from 'cookies-next';
import { useEffect, useState } from 'react';

import { getNotificationPermission, isIOSDevice, isIOSPWA, isNotificationSupported } from './notifications';
import type { AuthConfig, NotificationUtils } from './types';

export function createNotificationPermission(config: AuthConfig, notificationUtils: NotificationUtils) {
  const useNotificationPermission = () => {
    const [showModal, setShowModal] = useState(false);
    const [showSuccessModal, setShowSuccessModal] = useState(false);
    const [showIOSInstallPrompt, setShowIOSInstallPrompt] = useState(false);
    const [permissionStatus, setPermissionStatus] = useState<NotificationPermission>('default');
    const [isIOS, setIsIOS] = useState(false);
    const [canShowNotificationPrompt, setCanShowNotificationPrompt] = useState(false);

    // iOS detection helper - Allow notifications in PWA mode on iOS
    const detectIOSEnvironment = () => {
      const iosDetected = isIOSDevice();
      const isInPWAMode = isIOSPWA();
      const isInStandaloneMode = window.matchMedia('(display-mode: standalone)').matches;
      const isInWebAppCapable = (window.navigator as any).standalone === true;
      const isInAppBrowser =
        window.navigator.userAgent.includes('Instagram') ||
        window.navigator.userAgent.includes('FBAN') ||
        window.navigator.userAgent.includes('FBAV') ||
        window.navigator.userAgent.includes('Twitter') ||
        window.navigator.userAgent.includes('LinkedInApp');

      return {
        isIOSDevice: iosDetected,
        isInStandaloneMode,
        isInWebAppCapable,
        isInAppBrowser,
        isInPWAMode,
        // Allow notifications on non-iOS devices OR iOS devices in PWA mode
        canUseNotifications: !iosDetected || isInPWAMode,
      };
    };

    useEffect(() => {
      // Clean up old version localStorage keys on mount
      notificationUtils.cleanupOldVersions();

      const iosInfo = detectIOSEnvironment();

      setIsIOS(iosInfo.isIOSDevice);

      // Check if notifications are supported
      if (!isNotificationSupported()) {
        return;
      }

      // iOS specific checks - Allow notifications in PWA mode
      if (iosInfo.isIOSDevice && !iosInfo.canUseNotifications) {
        // iOS device but not in PWA mode - don't show notification prompts
        setCanShowNotificationPrompt(false);

        return;
      }

      // Notifications are supported (either non-iOS or iOS in PWA mode)
      setCanShowNotificationPrompt(true);

      // Check current permission status
      const currentPermission = getNotificationPermission();

      setPermissionStatus(currentPermission);

      // Check if user has already seen the modal (using versioned storage)
      const hasSeenModalForVersion = notificationUtils.hasSeenNotificationModal();
      const hasSeenSuccessForVersion = notificationUtils.hasSeenSuccessModal();
      const token = getCookie(config.cookieKey);

      // Show modal if:
      // 1. User hasn't seen the modal before (for current version) - REGARDLESS of permission status
      // 2. User is authenticated
      // 3. Can show notification prompt (not iOS without PWA)
      // This ensures ALL users (even those who granted permission before) see the modal in new versions
      if (!hasSeenModalForVersion && token && canShowNotificationPrompt) {
        const timer = setTimeout(() => {
          setShowModal(true);
        }, 2000);

        return () => clearTimeout(timer);
      }

      // Show success modal if permission is granted and not shown before (for current version)
      // Only show if user already had permission granted from a previous session
      if (currentPermission === 'granted' && !hasSeenSuccessForVersion && hasSeenModalForVersion && token) {
        setShowSuccessModal(true);
        notificationUtils.setSuccessModalShown();
      }
    }, [canShowNotificationPrompt]);

    const handlePermissionRequest = async () => {
      try {
        // Request permission (this must be called from user interaction)
        const permission = await Notification.requestPermission();

        setPermissionStatus(permission);

        if (permission === 'granted') {
          handlePermissionGranted();
          // Mark that we've shown the modal (using versioned storage)
          notificationUtils.setNotificationModalShown();
          setShowModal(false);
        } else {
          // User denied permission
          notificationUtils.setNotificationModalShown();
          setShowModal(false);
        }

        return permission;
      } catch (error) {
        console.log('Error requesting notification permission:', error);
        notificationUtils.setNotificationModalShown();
        setShowModal(false);

        return 'denied';
      }
    };

    const handlePermissionGranted = () => {
      setPermissionStatus('granted');
      notificationUtils.setPermissionGranted();

      // Show success modal if not already shown (using versioned storage)
      if (!notificationUtils.hasSeenSuccessModal()) {
        setShowSuccessModal(true);
        notificationUtils.setSuccessModalShown();
      }
    };

    const handleCloseModal = () => {
      setShowModal(false);
      notificationUtils.setNotificationModalShown();
    };

    const handleCloseSuccessModal = () => {
      setShowSuccessModal(false);
    };

    const handleCloseIOSPrompt = () => {
      setShowIOSInstallPrompt(false);
      localStorage.setItem('ios-install-prompt-shown', 'true');
    };

    const resetModalState = () => {
      notificationUtils.resetNotificationState();
      localStorage.removeItem('ios-install-prompt-shown');
      setShowModal(false);
      setShowSuccessModal(false);
      setShowIOSInstallPrompt(false);
    };

    return {
      showModal,
      showSuccessModal,
      showIOSInstallPrompt,
      permissionStatus,
      isIOS,
      canShowNotificationPrompt,
      handlePermissionRequest,
      handlePermissionGranted,
      handleCloseModal,
      handleCloseSuccessModal,
      handleCloseIOSPrompt,
      resetModalState,
    };
  };

  return useNotificationPermission;
}
