// React Query wrappers over `endpoints.ts` for the shell screens. Features may add their own.
import type { ItemType } from './types';
import type { RulerPreset } from '@/lib/ruler/preset';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { isMockRoute } from './client';
import * as endpoints from './endpoints';

import { isValidAdminToken, readSessionToken, useGetUserData } from '@/lib/auth';
import {
  getBackendSettingsServerSnapshot,
  getBackendSettingsSnapshot,
  subscribeBackendSettings,
} from '@/lib/backend-settings';

const subscribeNever = () => () => {};

/**
 * False on the server and during the hydration render, true from the first client commit on. The
 * session lives in a cookie/localStorage the server cannot read, so anything derived from it must
 * agree with the server markup until React has hydrated — otherwise every page mismatches
 * (`<LoadingRows>` on the client against the idle markup the server rendered).
 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}

/**
 * Whether the shell's queries should run at all: a live admin session, or forced-mock mode (the
 * mock needs no token). Signed out in hybrid/live mode every call would be a 401 — after sign-out
 * the rail and the sync watcher used to fire two of them before /login mounted.
 */
export function useStudyQueriesEnabled(): boolean {
  const hydrated = useHydrated();
  const { mockMode } = useSyncExternalStore(
    subscribeBackendSettings,
    getBackendSettingsSnapshot,
    getBackendSettingsServerSnapshot,
  );
  // `useGetUserData` re-renders on storage changes; the cookie is the live truth.
  const { token } = useGetUserData();
  const live = typeof token === 'string' && token ? token : readSessionToken();

  return hydrated && (mockMode === 'mock' || isValidAdminToken(live));
}

export const studyKeys = {
  today: ['study', 'today'] as const,
  classes: (term?: string) => ['study', 'classes', term ?? 'current'] as const,
  modules: (classId: string) => ['study', 'modules', classId] as const,
  items: (classId: string, type?: ItemType, q?: string) => ['study', 'items', classId, type ?? '', q ?? ''] as const,
  item: (itemId: string) => ['study', 'item', itemId] as const,
  transcript: (itemId: string) => ['study', 'transcript', itemId] as const,
  pages: (classId?: string | null, itemId?: string | null) => ['study', 'pages', classId ?? '', itemId ?? ''] as const,
  rulers: (pageId: string) => ['study', 'rulers', pageId] as const,
  search: (q: string) => ['study', 'search', q] as const,
  canvas: ['study', 'canvas'] as const,
  mcpKeys: ['study', 'mcp-keys'] as const,
  mcpConnections: ['study', 'mcp-connections'] as const,
  mastery: (classId?: string) => ['study', 'mastery', classId ?? ''] as const,
};

/**
 * Reactive `isMockRoute`: whether this path is answered by the mock under the current settings.
 * False until mounted — the setting lives in localStorage, so the server render cannot know it and a
 * banner that differs between SSR and the client would be a hydration mismatch.
 */
export function useSampleRoute(path: string, method = 'GET'): boolean {
  useSyncExternalStore(subscribeBackendSettings, getBackendSettingsSnapshot, getBackendSettingsServerSnapshot);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  return mounted && isMockRoute(path, method);
}

export const useToday = () =>
  useQuery({
    queryKey: studyKeys.today,
    queryFn: endpoints.getToday,
    staleTime: 30_000,
    enabled: useStudyQueriesEnabled(),
  });

export const useClasses = (term?: 'all' | string) =>
  useQuery({
    queryKey: studyKeys.classes(term),
    queryFn: () => endpoints.listClasses(term),
    staleTime: 60_000,
    enabled: useStudyQueriesEnabled(),
  });

/** Create / rename / delete a class of his own; refreshes every class list and Today. */
export function useManualClassMutations() {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['study', 'classes'] });
    void queryClient.invalidateQueries({ queryKey: studyKeys.today });
  };

  return {
    create: useMutation({ mutationFn: endpoints.createClass, onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ id, ...patch }: { id: string; name?: string; code?: string; color?: string }) =>
        endpoints.patchClass(id, patch),
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: endpoints.deleteClass, onSuccess: refresh }),
  };
}

export const useClassModules = (classId: string) =>
  useQuery({
    queryKey: studyKeys.modules(classId),
    queryFn: () => endpoints.getClassModules(classId),
    enabled: useStudyQueriesEnabled() && !!classId,
  });

export const useClassItems = (classId: string, filter: { type?: ItemType; q?: string } = {}) =>
  useQuery({
    queryKey: studyKeys.items(classId, filter.type, filter.q),
    queryFn: () => endpoints.listClassItems(classId, filter),
    enabled: useStudyQueriesEnabled() && !!classId,
  });

export const useItem = (itemId: string) =>
  useQuery({
    queryKey: studyKeys.item(itemId),
    queryFn: () => endpoints.getItem(itemId),
    enabled: useStudyQueriesEnabled() && !!itemId,
  });

export const useVideoTranscript = (itemId: string, enabled = true) =>
  useQuery({
    queryKey: studyKeys.transcript(itemId),
    queryFn: () => endpoints.getVideoTranscript(itemId),
    enabled: useStudyQueriesEnabled() && !!itemId && enabled,
    retry: false,
  });

export const usePages = (filter: { classId?: string | null; itemId?: string | null } = {}) =>
  useQuery({
    queryKey: studyKeys.pages(filter.classId, filter.itemId),
    queryFn: () => endpoints.listPages(filter),
    enabled: useStudyQueriesEnabled(),
  });

export const useSearch = (q: string) =>
  useQuery({
    queryKey: studyKeys.search(q),
    queryFn: () => endpoints.search(q),
    enabled: useStudyQueriesEnabled() && q.trim().length > 1,
  });

/** Polls every 5 s while a Canvas sync runs (saving a token kicks one off; ~95 s for 4 classes). */
export const useCanvasStatus = (enabled = true) =>
  useQuery({
    queryKey: studyKeys.canvas,
    queryFn: endpoints.getCanvasConnection,
    enabled: useStudyQueriesEnabled() && enabled,
    retry: false,
    refetchInterval: (query) => (query.state.data?.syncing ? 5_000 : false),
  });

/**
 * Mounted once in the shell: when a sync finishes (`syncing` true → false) the class list, Today and
 * every items query are stale, so they are refetched without the user touching anything.
 */
export function useCanvasSyncWatcher(enabled = true): { syncing: boolean } {
  const queryClient = useQueryClient();
  const { data } = useCanvasStatus(enabled);
  const syncing = Boolean(data?.syncing);
  const wasSyncing = useRef(false);

  useEffect(() => {
    if (wasSyncing.current && !syncing) {
      void queryClient.invalidateQueries({ queryKey: ['study', 'classes'] });
      void queryClient.invalidateQueries({ queryKey: studyKeys.today });
      void queryClient.invalidateQueries({ queryKey: ['study', 'items'] });
      void queryClient.invalidateQueries({ queryKey: ['study', 'modules'] });
    }
    wasSyncing.current = syncing;
  }, [queryClient, syncing]);

  return { syncing };
}

export const useMcpKeys = () =>
  useQuery({
    queryKey: studyKeys.mcpKeys,
    queryFn: endpoints.listMcpKeys,
    retry: false,
    enabled: useStudyQueriesEnabled(),
  });

export const useMcpConnections = () =>
  useQuery({
    queryKey: studyKeys.mcpConnections,
    queryFn: endpoints.listMcpConnections,
    retry: false,
    enabled: useStudyQueriesEnabled(),
  });

export const useMastery = (classId?: string) =>
  useQuery({
    queryKey: studyKeys.mastery(classId),
    queryFn: () => endpoints.getMastery(classId),
    enabled: useStudyQueriesEnabled(),
  });

/** Marks an item seen and refreshes everything that counts unseen items. */
export function useMarkSeen() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: endpoints.markItemSeen,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: studyKeys.today });
      void queryClient.invalidateQueries({ queryKey: ['study', 'classes'] });
      void queryClient.invalidateQueries({ queryKey: ['study', 'items'] });
    },
  });
}

export function useInvalidateStudy() {
  const queryClient = useQueryClient();

  return () => queryClient.invalidateQueries({ queryKey: ['study'] });
}

/** Ruler presets for a notebook page. A 404 (backend not live) is just «none»: the ruler works as before. */
export const useRulerPresets = (pageId: string) =>
  useQuery({
    queryKey: studyKeys.rulers(pageId),
    queryFn: () => endpoints.getRulerPresets(pageId).then((r) => r.rulers ?? {}, () => ({}) as Record<string, never>),
    staleTime: 60_000,
    enabled: useStudyQueriesEnabled() && !!pageId,
  });

export function usePutRulerPreset(pageId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ page, preset }: { page: number; preset: RulerPreset }) => endpoints.putRulerPreset(pageId, page, preset),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: studyKeys.rulers(pageId) }),
  });
}
