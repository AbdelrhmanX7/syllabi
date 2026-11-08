// React Query wrappers for the class library (P-CM). Endpoint functions live in `@/lib/api/endpoints`.
import { useQuery } from '@tanstack/react-query';

import { getLibraryDoc, listClassLibrary, searchClassLibrary } from '@/lib/api/endpoints';

export const libraryKeys = {
  list: (classId: string) => ['study', 'library', 'list', classId] as const,
  doc: (libraryId: string) => ['study', 'library', 'doc', libraryId] as const,
  search: (classId: string, q: string) => ['study', 'library', 'search', classId, q] as const,
};

export const useClassLibrary = (classId: string) =>
  useQuery({
    queryKey: libraryKeys.list(classId),
    queryFn: () => listClassLibrary(classId),
    enabled: !!classId,
    staleTime: 5 * 60_000,
  });

/** Signed urls last ~1 h: refetch well before that so an open PDF/image never 403s. */
export const useLibraryDoc = (libraryId: string | null) =>
  useQuery({
    queryKey: libraryKeys.doc(libraryId ?? ''),
    queryFn: () => getLibraryDoc(libraryId!),
    enabled: !!libraryId,
    staleTime: 30 * 60_000,
  });

export const useLibrarySearch = (classId: string, q: string) =>
  useQuery({
    queryKey: libraryKeys.search(classId, q),
    queryFn: () => searchClassLibrary(classId, { q, limit: 20 }),
    enabled: !!classId && q.trim().length >= 2,
    staleTime: 60_000,
  });
