import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/router';

import { FLASHCARDS_KEY } from '@/features/flashcards/hooks';
import { listFlashcards } from '@/features/flashcards/api';
import { getToday } from '@/lib/api/endpoints';
import { studyKeys, useStudyQueriesEnabled } from '@/lib/api/hooks';
import { fetchNews, newsToShow } from '@/lib/reminders/news';
import { applySchedule, hasPermission, listenForTaps, showNow } from '@/lib/reminders/notify';
import { planReminders } from '@/lib/reminders/plan';
import { readList, useReminderSettings, writeList } from '@/lib/reminders/settings';

const NEWS_SEEN_KEY = 'study_news_seen';
/** On resume, refresh Today / flashcards at most this often (they feed the schedule). */
const RESUME_REFRESH_MS = 5 * 60_000;

/**
 * Keeps the device's reminders in step with the app's data: re-plans when Today, the flashcards or the
 * Reminders settings change and whenever the app comes back to the front, and shows new team messages
 * once. Renders nothing.
 */
export function RemindersAgent() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const settings = useReminderSettings();
  const queriesOn = useStudyQueriesEnabled();
  // Same key as the Today page (shared cache), but only fetched while reminders are on.
  const today = useQuery({
    queryKey: studyKeys.today,
    queryFn: getToday,
    staleTime: 30_000,
    enabled: queriesOn && settings.enabled,
  });
  const cards = useQuery({
    queryKey: FLASHCARDS_KEY,
    queryFn: listFlashcards,
    staleTime: 30_000,
    enabled: queriesOn && settings.enabled && settings.flashcards,
  });
  // Bumped on resume so the plan is recomputed from the new «now».
  const [wake, setWake] = useState(0);
  const lastRefresh = useRef(0);

  useEffect(() => listenForTaps((path) => void router.push(path)), [router]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      setWake((n) => n + 1);
      if (queriesOn && settings.enabled && Date.now() - lastRefresh.current > RESUME_REFRESH_MS) {
        lastRefresh.current = Date.now();
        void queryClient.refetchQueries({ queryKey: studyKeys.today, type: 'active' });
        if (settings.flashcards) void queryClient.refetchQueries({ queryKey: FLASHCARDS_KEY, type: 'active' });
      }
    };

    document.addEventListener('visibilitychange', onVisible);

    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [queryClient, queriesOn, settings.enabled, settings.flashcards]);

  const classLabels = useMemo(
    () => Object.fromEntries((today.data?.classes ?? []).map((c) => [c.id, c.code || c.name])),
    [today.data?.classes],
  );

  useEffect(() => {
    if (!settings.enabled) {
      void applySchedule([]);

      return;
    }
    // No data yet (cold start, offline, slow): leave what is scheduled alone rather than wipe it.
    // Signed out there is nothing to load, so own reminders still go ahead.
    if (queriesOn && ((settings.due && !today.data) || (settings.flashcards && !cards.data))) return;
    const timer = setTimeout(() => {
      void hasPermission().then((granted) => {
        if (!granted) return applySchedule([]);

        return applySchedule(
          planReminders({
            settings,
            items: today.data?.due ?? [],
            classLabels,
            cards: cards.data ?? [],
            custom: settings.custom,
            now: Date.now(),
          }),
        );
      });
    }, 1_500);

    return () => clearTimeout(timer);
  }, [settings, queriesOn, today.data, cards.data, classLabels, wake]);

  // Team messages: on open and on every resume, only while reminders are on.
  useEffect(() => {
    if (!settings.enabled) return;
    let cancelled = false;

    void (async () => {
      if (!(await hasPermission())) return;
      const feed = await fetchNews();
      const seen = readList(NEWS_SEEN_KEY);
      const fresh = newsToShow(feed, seen, Date.now());

      if (cancelled || !fresh.length) return;
      writeList(NEWS_SEEN_KEY, [...seen, ...fresh.map((m) => m.id)]);
      for (const m of fresh) await showNow({ key: `news:${m.id}`, title: m.title, body: m.body, url: m.url });
    })();

    return () => {
      cancelled = true;
    };
  }, [settings.enabled, wake]);

  return null;
}
