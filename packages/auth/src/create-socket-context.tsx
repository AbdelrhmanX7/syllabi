import React, { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';

import type { Socket } from 'socket.io-client';
import type { SocketUtils, SocketContextType } from './types';

export function createSocketContext(socketUtils: SocketUtils) {
  const SocketContext = createContext<SocketContextType>({
    socket: null,
    isConnected: false,
    status: 'not_initialized',
    connectionId: null,
  });

  const SocketProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [socket, setSocket] = useState<Socket | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [status, setStatus] = useState<SocketContextType['status']>('not_initialized');
    const [connectionId, setConnectionId] = useState<string | null>(null);

    const updateSocketState = useCallback(() => {
      const currentSocket = socketUtils.getSocket();
      const connected = socketUtils.isSocketConnected();
      const currentStatus = socketUtils.getSocketStatus();

      setSocket(currentSocket);
      setIsConnected(connected);
      setStatus(currentStatus);
      setConnectionId(currentSocket?.id || null);
    }, []);

    useEffect(() => {
      updateSocketState();

      socketUtils.onSocketInitialized(() => {
        updateSocketState();
      });
    }, [updateSocketState]);

    /*
     * Bind the connection listeners in their OWN effect, keyed on the socket instance.
     *
     * This used to live in the mount effect above, guarded by `if (getSocket())` with
     * `[]` deps — but `initSocket` awaits a dynamic `import('socket.io-client')`, so at
     * provider mount the socket almost never exists yet. The guard failed, the effect
     * never retried, and NO connect/disconnect listener was ever attached: the whole
     * context was driven by the 5-second poll below, which publishes the socket object
     * the moment it exists — i.e. while it is still connecting. Keying on `socket` means
     * the listeners attach as soon as the instance appears.
     */
    useEffect(() => {
      if (!socket) return;

      /*
       * `reconnect` lives on the MANAGER (`socket.io`), not the socket — see the note
       * in create-socket.ts. Bound below via `socket.io`.
       */
      const currentSocket = socket;

      const handleConnect = () => {
        if (process.env.NODE_ENV === 'development') {
          // eslint-disable-next-line no-console
          console.log('🔗 Socket context: Connected');
        }
        updateSocketState();
      };

      const handleDisconnect = (reason: string) => {
        if (process.env.NODE_ENV === 'development') {
          // eslint-disable-next-line no-console
          console.log('🔗 Socket context: Disconnected', reason);
        }
        updateSocketState();
      };

      const handleReconnect = () => {
        if (process.env.NODE_ENV === 'development') {
          // eslint-disable-next-line no-console
          console.log('🔗 Socket context: Reconnected');
        }
        updateSocketState();
      };

      currentSocket.on('connect', handleConnect);
      currentSocket.on('disconnect', handleDisconnect);
      currentSocket.io.on('reconnect', handleReconnect);

      return () => {
        currentSocket.off('connect', handleConnect);
        currentSocket.off('disconnect', handleDisconnect);
        currentSocket.io.off('reconnect', handleReconnect);
      };
    }, [socket, updateSocketState]);

    // Periodic status check to ensure state consistency
    useEffect(() => {
      const interval = setInterval(() => {
        const currentSocket = socketUtils.getSocket();
        const connected = socketUtils.isSocketConnected();
        const currentStatus = socketUtils.getSocketStatus();

        if (
          socket !== currentSocket ||
          isConnected !== connected ||
          status !== currentStatus ||
          connectionId !== (currentSocket?.id || null)
        ) {
          setSocket(currentSocket);
          setIsConnected(connected);
          setStatus(currentStatus);
          setConnectionId(currentSocket?.id || null);
        }
      }, 5000);

      return () => clearInterval(interval);
    }, [socket, isConnected, status, connectionId]);

    const contextValue: SocketContextType = {
      socket,
      isConnected,
      status,
      connectionId,
    };

    return <SocketContext.Provider value={contextValue}>{children}</SocketContext.Provider>;
  };

  const useSocketContext = (): SocketContextType => {
    const context = useContext(SocketContext);

    if (!context) {
      throw new Error('useSocketContext must be used within a SocketProvider');
    }

    return context;
  };

  const useSocket = (): Socket | null => {
    const { socket } = useSocketContext();

    return socket;
  };

  return { SocketProvider, useSocketContext, useSocket };
}
