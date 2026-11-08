// Sharing endpoints (`/share`, live when it is in LIVE_ROUTES, else features/share/mock.ts) + query hooks.
import type { ForkRecord, ForkResult, Share, SharedView, SharedWithMeItem, ShareResourceType, ShareTarget } from './types';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { studyDelete, studyGet, studyPatch, studyPost } from '@/lib/api/http';
import { useStudyQueriesEnabled } from '@/lib/api/hooks';

const enc = encodeURIComponent;

const refQuery = (t: Pick<ShareTarget, 'resourceType' | 'resourceId' | 'topic'>) =>
  `resourceType=${enc(t.resourceType)}&resourceId=${enc(t.resourceId)}${t.topic ? `&topic=${enc(t.topic)}` : ''}`;

export const getMyShare = (t: ShareTarget) => studyGet<{ share: Share | null }>(`/share/mine?${refQuery(t)}`);
export const createShare = (t: ShareTarget, body: { emails?: string[]; link?: boolean }) =>
  studyPost<{ share: Share }>('/share', {
    resourceType: t.resourceType,
    resourceId: t.resourceId,
    topic: t.topic ?? null,
    // Ignored by the server (it reads the title off the resource); the demo mock shows it.
    title: t.title,
    ...body,
  });
export const patchShare = (id: string, body: { addEmails?: string[]; removeEmails?: string[]; link?: boolean }) =>
  studyPatch<{ share: Share }>(`/share/${enc(id)}`, body);
export const deleteShare = (id: string) => studyDelete(`/share/${enc(id)}`);
export const listSharedWithMe = () => studyGet<{ items: SharedWithMeItem[] }>('/share/with-me');
export const listForks = () => studyGet<{ items: ForkRecord[] }>('/share/forks');
export const viewShared = (idOrToken: string) => studyGet<SharedView>(`/share/view/${enc(idOrToken)}`);
export const forkShared = (idOrToken: string) => studyPost<ForkResult>(`/share/fork/${enc(idOrToken)}`);

export const shareKeys = {
  mine: (t: Pick<ShareTarget, 'resourceType' | 'resourceId' | 'topic'>) =>
    ['share', 'mine', t.resourceType, t.resourceId, t.topic ?? null] as const,
  withMe: ['share', 'with-me'] as const,
  forks: ['share', 'forks'] as const,
  view: (idOrToken: string) => ['share', 'view', idOrToken] as const,
};

export function useMyShare(target: ShareTarget, enabled = true) {
  const queriesEnabled = useStudyQueriesEnabled();

  return useQuery({
    queryKey: shareKeys.mine(target),
    queryFn: async () => (await getMyShare(target)).share,
    enabled: queriesEnabled && enabled,
  });
}

/** Every change to a share answers with the new share: write it into the cache. */
export function useShareMutations(target: ShareTarget) {
  const client = useQueryClient();
  const key = shareKeys.mine(target);
  const put = (share: Share | null) => client.setQueryData(key, share);

  /** Add people / toggle the link: creates the share on first use. */
  const update = useMutation({
    mutationFn: async ({
      current,
      addEmails,
      removeEmails,
      link,
    }: {
      current: Share | null | undefined;
      addEmails?: string[];
      removeEmails?: string[];
      link?: boolean;
    }) =>
      current
        ? (await patchShare(current.id, { addEmails, removeEmails, link })).share
        : (await createShare(target, { emails: addEmails, link })).share,
    onSuccess: put,
  });
  const stop = useMutation({
    mutationFn: async (id: string) => deleteShare(id),
    onSuccess: () => put(null),
  });

  return { update, stop };
}

export function useSharedWithMe() {
  const enabled = useStudyQueriesEnabled();

  return useQuery({
    queryKey: shareKeys.withMe,
    queryFn: async () => (await listSharedWithMe()).items,
    enabled,
  });
}

export function useSharedView(idOrToken: string) {
  const enabled = useStudyQueriesEnabled();

  return useQuery({
    queryKey: shareKeys.view(idOrToken),
    queryFn: () => viewShared(idOrToken),
    enabled: enabled && Boolean(idOrToken),
    retry: false,
  });
}

export function useForks() {
  const enabled = useStudyQueriesEnabled();

  return useQuery({
    queryKey: shareKeys.forks,
    queryFn: async () => (await listForks()).items,
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Where this copy came from (null = not a copy). deck / questions match on class + topic. */
export function useForkedFrom(resourceType: ShareResourceType, resourceId: string | null | undefined, topic?: string | null) {
  const { data } = useForks();

  if (!resourceId || !data) return null;

  return (
    data.find(
      (f) =>
        f.resourceType === resourceType &&
        f.resourceId === resourceId &&
        (resourceType === 'deck' || resourceType === 'questions' ? (f.topic ?? null) === (topic ?? null) : true),
    ) ?? null
  );
}

export function useFork() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (idOrToken: string) => forkShared(idOrToken),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: shareKeys.forks });
      // The copy lands in pages / questions / classes / concept maps.
      void client.invalidateQueries({ queryKey: ['study'] });
    },
  });
}

/** Where the new copy opens. */
export function forkHref(result: ForkResult): string {
  switch (result.resourceType) {
    case 'notebook':
      return `/notebook/?id=${enc(result.resourceId)}`;
    case 'deck':
      return `/flashcards/?classId=${enc(result.resourceId)}`;
    case 'questions':
      return `/bank/?classId=${enc(result.resourceId)}${result.topic ? `&topic=${enc(result.topic)}` : ''}`;
    case 'conceptMap':
      return `/concept-maps/?classId=${enc(result.classId ?? '')}&map=${enc(result.resourceId)}`;
  }
}
