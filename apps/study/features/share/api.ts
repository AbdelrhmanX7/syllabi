// Sharing endpoints (`/share`, live when it is in LIVE_ROUTES, else features/share/mock.ts) + query hooks.
import type { ForkRecord, ForkResult, Share, SharedView, SharedWithMeItem, ShareResourceType, ShareRole, ShareTarget } from './types';
import type { Question } from '@/lib/api/types';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { studyDelete, studyGet, studyPatch, studyPost } from '@/lib/api/http';
import { useStudyQueriesEnabled } from '@/lib/api/hooks';

const enc = encodeURIComponent;

const refQuery = (t: Pick<ShareTarget, 'resourceType' | 'resourceId' | 'topic'>) =>
  `resourceType=${enc(t.resourceType)}&resourceId=${enc(t.resourceId)}${t.topic ? `&topic=${enc(t.topic)}` : ''}`;

export const getMyShare = (t: ShareTarget) => studyGet<{ share: Share | null }>(`/share/mine?${refQuery(t)}`);
export interface PersonRole {
  email: string;
  role: ShareRole;
}

export const createShare = (t: ShareTarget, body: { emails?: string[]; role?: ShareRole; link?: boolean }) =>
  studyPost<{ share: Share }>('/share', {
    resourceType: t.resourceType,
    resourceId: t.resourceId,
    topic: t.topic ?? null,
    // Ignored by the server (it reads the title off the resource); the demo mock shows it.
    title: t.title,
    ...body,
  });
export const patchShare = (
  id: string,
  body: { addEmails?: string[]; role?: ShareRole; removeEmails?: string[]; roles?: PersonRole[]; link?: boolean },
) =>
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

  /** Add people (with `role`) / change roles / remove / toggle the link: creates the share on first use. */
  const update = useMutation({
    mutationFn: async ({
      current,
      addEmails,
      role,
      removeEmails,
      roles,
      link,
    }: {
      current: Share | null | undefined;
      addEmails?: string[];
      role?: ShareRole;
      removeEmails?: string[];
      roles?: PersonRole[];
      link?: boolean;
    }) =>
      current
        ? (await patchShare(current.id, { addEmails, role, removeEmails, roles, link })).share
        : (await createShare(target, { emails: addEmails, role, link })).share,
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

/* ------------------------------------------------------------------ editing the original (Can edit) */

// Editors write through the normal study routes with the owner's ids; the server checks the share.
export const patchSharedQuestion = (id: string, patch: { stem?: string; answer?: string }) =>
  studyPatch<Question>(`/questions/${enc(id)}`, patch);
export const deleteSharedQuestion = (id: string) => studyDelete(`/questions/${enc(id)}`);
export const addSharedQuestion = (q: { classId: string; topic: string; stem: string; answer: string; tags: string[] }) =>
  studyPost<Question[]>('/questions', { questions: [{ ...q, type: 'free' }] });
export const patchSharedMapTerms = (id: string, promptTerms: string[]) =>
  studyPatch<{ id: string; promptTerms: string[] }>(`/concept-maps/${enc(id)}`, { promptTerms });

/** After an edit: refresh the shared view and the "Shared with me" list. */
export function useSharedEdit<TArgs, TResult>(shareId: string, fn: (args: TArgs) => Promise<TResult>) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: shareKeys.view(shareId) });
      void client.invalidateQueries({ queryKey: shareKeys.withMe });
    },
  });
}

/* ------------------------------------------------------------------ earlier versions of a notebook page (owner) */

export interface PageVersion {
  version: number;
  by: { name: string; isOwner: boolean } | null;
  at: string | null;
  restoredFrom: number | null;
}

export const listPageVersions = (pageId: string) =>
  studyGet<{ current: number; items: PageVersion[]; next: number | null }>(`/pages/${enc(pageId)}/versions`);
export const restorePageVersion = (pageId: string, version: number, baseVersion: number) =>
  studyPost<{ version: number }>(`/pages/${enc(pageId)}/versions/${version}/restore`, { baseVersion });
