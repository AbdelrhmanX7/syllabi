import type { McpConnection, McpKey } from '@/lib/api/types';
import type { MockMode } from '@/lib/backend-settings';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  KeyRound,
  Link2,
  Moon,
  RefreshCw,
  Sun,
  Trash2,
  Unplug,
} from 'lucide-react';
import { DatePicker } from '@repo/ui';
import Head from 'next/head';
import { useTheme } from 'next-themes';

import { PageHeader } from '@/components/layout/PageHeader';
import { UpdateProgress } from '@/components/layout/UpdateBanner';
import { NotebookPaperSection } from '@/components/settings/NotebookPaperSection';
import { InkAutoColorSection } from '@/components/settings/InkAutoColorSection';
import { PerfLogSection } from '@/components/settings/PerfLogSection';
import { UsageSection } from '@/components/settings/UsageSection';
import { RemindersSection } from '@/components/settings/RemindersSection';
import { SoundsSection } from '@/components/settings/SoundsSection';
import { WebUpdatesSection } from '@/components/settings/WebUpdatesSection';
import { AccountSection } from '@/features/auth/components/AccountSection';
import { HandwritingSection } from '@/features/handwriting';
import { PhoneInboxSection } from '@/features/inbox';
import { ClassTimesSection } from '@/features/lecturenotes/components/ClassTimes';
import { ConfirmSheet } from '@/components/ui/ConfirmSheet';
import { SampleDataBanner } from '@/components/ui/SampleDataBanner';
import {
  ActionButton,
  Badge,
  ErrorNote,
  Field,
  FilterChip,
  INPUT_CLASS,
  LoadingRows,
  SectionTitle,
  Surface,
} from '@/components/ui/primitives';
import { useAppUpdate } from '@/hooks/useAppUpdate';
import { useBackendSettings, useResolvedMode } from '@/hooks/useBackendSettings';
import { useSession } from '@/hooks/useSession';
import { errorReason, track } from '@/lib/analytics';
import { LIVE_ROUTES } from '@/lib/api/client';
import {
  createMcpKey,
  deleteCanvasConnection,
  disconnectMcpConnection,
  putCanvasConnection,
  revokeMcpKey,
  startCanvasSync,
} from '@/lib/api/endpoints';
import { describeError } from '@/lib/api/errors';
import { studyKeys, useCanvasStatus, useMcpConnections, useMcpKeys, useSampleRoute } from '@/lib/api/hooks';
import { getBuildTimeApiBaseUrl, saveBackendUrlOverride, saveMockMode } from '@/lib/backend-settings';
import { daysUntil, formatDateTime, formatRelative } from '@/lib/format';
import { canInstallInApp, checkForUpdates, startUpdate } from '@/lib/platform/app-update';
import { SELF_UPDATE_ENABLED } from '@/lib/platform/store';
import { isTauri } from '@/lib/platform/runtime';

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <ActionButton
      className='min-h-9 px-3 text-xs'
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_500);
        } catch {
          // clipboard blocked — the text is visible to select
        }
      }}
    >
      {copied ? <Check className='text-st-ok h-3.5 w-3.5' /> : <Copy className='h-3.5 w-3.5' />}{' '}
      {copied ? 'Copied' : label}
    </ActionButton>
  );
}

function CanvasSection() {
  const queryClient = useQueryClient();
  const status = useCanvasStatus();
  const [token, setToken] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: studyKeys.canvas });
  const save = useMutation({
    mutationFn: () =>
      putCanvasConnection({
        baseUrl: baseUrl.trim(),
        // Pasted tokens often carry quotes/backticks, a `Bearer ` prefix or a `KEY=` label — keep only the token.
        token: token
          .trim()
          .replace(/^[A-Z_]+=/, '')
          .replace(/^Bearer\s+/i, '')
          .replace(/[`'"\s]/g, ''),
        // A date input value is a calendar day: «2027-01-01» parses as UTC midnight (Dec 31 in the Americas); the
        // token lasts through that day here.
        expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
      }),
    onMutate: () => track('canvas_connect_started', { reconnect: Boolean(status.data?.connected) }),
    onSuccess: () => {
      track('canvas_connect_succeeded');
      setToken('');
      void refresh();
    },
    onError: (error) => track('canvas_connect_failed', { reason: errorReason(error) }),
  });
  const sync = useMutation({ mutationFn: startCanvasSync, onSuccess: () => void refresh() });
  const disconnect = useMutation({ mutationFn: deleteCanvasConnection, onSuccess: () => void refresh() });
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const data = status.data;
  const expiryDays = daysUntil(data?.tokenExpiresAt);
  const expiring = expiryDays !== null && expiryDays < 7;

  return (
    <Surface className='p-5'>
      <SectionTitle
        action={
          data?.connected ? (
            <Badge tone={data.lastError ? 'warn' : 'ok'}>
              {data.syncing ? 'Syncing…' : data.lastError ? data.lastError.code : 'Connected'}
            </Badge>
          ) : (
            <Badge>Not connected</Badge>
          )
        }
      >
        <Link2 className='text-st-muted mr-1 inline h-4 w-4' /> Canvas connection
      </SectionTitle>

      {status.isLoading && !data && <LoadingRows rows={2} />}
      {status.error && <ErrorNote message={describeError(status.error)} onRetry={() => void status.refetch()} />}

      {data?.connected && (
        <div className='mb-4 grid gap-3 text-sm sm:grid-cols-2'>
          <div>
            <p className='text-st-muted text-xs'>Account</p>
            <p className='text-st-fg font-medium'>{data.canvasUser?.name ?? '—'}</p>
            <p className='text-st-muted text-xs'>{data.baseUrl}</p>
          </div>
          <div>
            <p className='text-st-muted text-xs'>Last sync</p>
            <p className='text-st-fg font-medium'>{data.lastSyncAt ? formatRelative(data.lastSyncAt) : 'never'}</p>
            {data.lastError && <p className='text-st-warn text-xs'>{data.lastError.message}</p>}
          </div>
          <div className='sm:col-span-2'>
            <p className='text-st-muted text-xs'>Token expires</p>
            <p className={expiring ? 'text-st-warn font-medium' : 'text-st-fg font-medium'}>
              {data.tokenExpiresAt ? `${formatDateTime(data.tokenExpiresAt)} (${expiryDays} days)` : 'unknown'}
              {expiring && ' — paste a new token below before it lapses.'}
            </p>
          </div>
          <div className='flex flex-wrap gap-3 sm:col-span-2'>
            <ActionButton loading={sync.isPending || data.syncing} variant='primary' onClick={() => sync.mutate()}>
              <RefreshCw className='h-4 w-4' /> Sync now
            </ActionButton>
            <ActionButton loading={disconnect.isPending} variant='danger' onClick={() => setConfirmDisconnect(true)}>
              <Unplug className='h-4 w-4' /> Disconnect
            </ActionButton>
            {confirmDisconnect && (
              <ConfirmSheet
                danger
                confirmLabel='Disconnect'
                title='Disconnect Canvas?'
                onClose={() => setConfirmDisconnect(false)}
                onConfirm={() => disconnect.mutate()}
              >
                Syncing stops and the saved token is removed. Your classes and notes stay; paste a token again to
                reconnect.
              </ConfirmSheet>
            )}
          </div>
        </div>
      )}

      <form
        className='border-st-line grid gap-3 border-t pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field
          hint='Canvas → Account → Settings → New access token (max 90 days).'
          label={data?.connected ? 'Replace access token' : 'Canvas access token'}
        >
          <input
            autoComplete='off'
            className={`${INPUT_CLASS} font-mono`}
            placeholder='1234~…'
            type='password'
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
        <Field hint='Optional — the date Canvas shows when you create it.' label='Token expiry'>
          <DatePicker aria-label='Token expiry' isClearable value={expiresAt} onChange={setExpiresAt} />
        </Field>
        <Field label='Canvas URL'>
          <input
            className={INPUT_CLASS}
            placeholder='https://yourschool.instructure.com'
            type='url'
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </Field>
        <div className='flex items-end'>
          <ActionButton
            className='w-full sm:w-auto'
            disabled={!token.trim() || !baseUrl.trim()}
            loading={save.isPending}
            type='submit'
            variant='primary'
          >
            Save & validate
          </ActionButton>
        </div>
        {save.error && (
          <div className='sm:col-span-2'>
            <ErrorNote message={describeError(save.error)} />
          </div>
        )}
      </form>
    </Surface>
  );
}

const MCP_TOOLS = [
  'list_classes',
  'get_today',
  'list_items',
  'get_item',
  'search',
  'get_transcript',
  'get_assignments',
  'get_weak_topics',
  'get_questions',
  'add_questions',
  'create_flashcards',
  'start_quiz',
  'answer_quiz',
  'explain_mistake',
  'create_study_plan',
  'add_note_page',
  'get_grades',
] as const;

/** The `claude mcp add` line for a key — the secret is shown exactly once, so the command is built then. */
const claudeCodeCommand = (endpoint: string, secret: string) =>
  `claude mcp add --transport http study ${endpoint} --header "Authorization: Bearer ${secret}"`;

function McpConnections() {
  const queryClient = useQueryClient();
  const connections = useMcpConnections();
  const [confirming, setConfirming] = useState<string | null>(null);
  const disconnect = useMutation({
    mutationFn: disconnectMcpConnection,
    onSuccess: (_data, id) => {
      setConfirming(null);
      queryClient.setQueryData<McpConnection[]>(studyKeys.mcpConnections, (rows) =>
        rows?.filter((row) => row.id !== id),
      );
      void queryClient.invalidateQueries({ queryKey: studyKeys.mcpConnections });
    },
  });

  return (
    <div className='border-st-line rounded-st mb-4 border p-4'>
      <p className='text-st-fg text-sm font-semibold'>Connected apps</p>
      <p className='text-st-muted mt-1 text-sm'>Stays signed in — no need to reconnect.</p>
      {connections.isLoading && !connections.data && <LoadingRows rows={1} />}
      {connections.error && (
        <ErrorNote message={describeError(connections.error)} onRetry={() => void connections.refetch()} />
      )}
      {connections.data && connections.data.length === 0 && (
        <p className='text-st-muted mt-3 text-sm'>No apps connected yet. Add the connector above to get started.</p>
      )}
      {connections.data && connections.data.length > 0 && (
        <ul className='divide-st-line mt-2 flex flex-col divide-y'>
          {connections.data.map((connection) => (
            <li key={connection.id} className='flex min-h-12 flex-wrap items-center gap-3 py-2 text-sm'>
              <span className='min-w-0 flex-1'>
                <span className='text-st-fg block font-medium'>{connection.clientName}</span>
                <span className='text-st-muted block text-xs'>
                  Connected {formatDateTime(connection.createdAt)} ·{' '}
                  {connection.lastUsedAt ? `Last used ${formatRelative(connection.lastUsedAt)}` : 'Never used'}
                </span>
                {connection.scopes.length > 0 && (
                  <span className='mt-1 flex flex-wrap gap-1'>
                    {connection.scopes.map((scope) => (
                      <Badge key={scope}>{scope}</Badge>
                    ))}
                  </span>
                )}
              </span>
              <ActionButton
                className='min-h-9 px-3 text-xs'
                loading={disconnect.isPending && disconnect.variables === connection.id}
                variant='danger'
                onClick={() => {
                  disconnect.reset();
                  setConfirming(connection.id);
                }}
              >
                <Unplug className='h-3.5 w-3.5' /> Disconnect
              </ActionButton>
            </li>
          ))}
        </ul>
      )}
      {confirming && (
        <ConfirmSheet
          danger
          confirmLabel='Disconnect'
          title={`Disconnect ${connections.data?.find((c) => c.id === confirming)?.clientName ?? 'this app'}?`}
          onClose={() => setConfirming(null)}
          onConfirm={() => disconnect.mutate(confirming)}
        >
          The app loses access to your study data until you connect it again.
        </ConfirmSheet>
      )}
      {disconnect.error && <ErrorNote message={describeError(disconnect.error)} />}
    </div>
  );
}

function McpSection() {
  const queryClient = useQueryClient();
  const keys = useMcpKeys();
  const { backendUrl } = useBackendSettings();
  const isSample = useSampleRoute('/mcp/keys');
  const [name, setName] = useState('Claude Code');
  const [fresh, setFresh] = useState<McpKey | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: studyKeys.mcpKeys });
  const create = useMutation({
    mutationFn: () => createMcpKey(name.trim() || 'Claude Code'),
    onSuccess: (key) => {
      setFresh(key);
      void refresh();
    },
  });
  const revoke = useMutation({ mutationFn: revokeMcpKey, onSuccess: () => void refresh() });
  const endpoint = `${backendUrl}/study/mcp`;
  const command = fresh?.secret ? claudeCodeCommand(endpoint, fresh.secret) : claudeCodeCommand(endpoint, '<key>');

  return (
    <Surface className='p-5'>
      <SectionTitle>
        <KeyRound className='text-st-muted mr-1 inline h-4 w-4' /> Connect Claude
      </SectionTitle>
      {isSample && <SampleDataBanner className='mb-4' what='MCP keys' />}
      <p className='text-st-muted mb-4 text-sm'>
        Claude can read your classes, assignments, notes and question bank — and add questions, flashcards and note
        pages — through this app&apos;s MCP server.
      </p>

      {/* claude.ai: OAuth — no key needed */}
      <div className='border-st-line rounded-st mb-3 border p-4'>
        <p className='text-st-fg text-sm font-semibold'>claude.ai (web, desktop, phone)</p>
        <ol className='text-st-muted mt-2 list-decimal space-y-1 pl-5 text-sm'>
          <li>
            Settings → Connectors → <span className='text-st-fg font-medium'>Add custom connector</span>.
          </li>
          <li>
            Name it <span className='text-st-fg font-medium'>Study</span>; URL:{' '}
            <code className='bg-st-raised text-st-fg rounded px-1.5 py-0.5 font-mono text-xs'>{endpoint}</code>. Leave
            client ID and client secret empty.
          </li>
          <li>Sign in with your Syllabi email + password when it asks, then approve the consent screen.</li>
        </ol>
        <div className='mt-3'>
          <CopyButton label='Copy URL' text={endpoint} />
        </div>
      </div>

      <McpConnections />

      {/* Claude Code: Bearer key */}
      <div className='border-st-line rounded-st mb-3 border p-4'>
        <p className='text-st-fg text-sm font-semibold'>Claude Code (terminal)</p>
        <p className='text-st-muted mt-1 text-sm'>
          Create a key below, then run this once. The key is shown a single time — copy it before leaving the page.
        </p>
        {fresh?.secret ? (
          <div className='rounded-st border-st-ok/30 bg-st-ok/5 mt-3 border p-3'>
            <p className='text-st-fg text-sm font-semibold'>
              New key “{fresh.name}” — copy it now, it will not be shown again.
            </p>
            <div className='mt-2 flex flex-wrap items-center gap-2'>
              <code className='bg-st-surface text-st-fg min-w-0 flex-1 select-all break-all rounded-sm px-3 py-2 font-mono text-xs'>
                {fresh.secret}
              </code>
              <CopyButton label='Copy key' text={fresh.secret} />
            </div>
            <div className='mt-2 flex flex-wrap items-start gap-2'>
              <pre className='bg-st-surface text-st-fg min-w-0 flex-1 select-all whitespace-pre-wrap break-all rounded-sm px-3 py-2 font-mono text-xs'>
                {command}
              </pre>
              <CopyButton label='Copy command' text={command} />
            </div>
          </div>
        ) : (
          <pre className='bg-st-raised text-st-muted mt-3 whitespace-pre-wrap break-all rounded-sm px-3 py-2 font-mono text-xs'>
            {command}
          </pre>
        )}
      </div>

      {/* tools */}
      <div className='border-st-line rounded-st mb-4 border'>
        <button
          aria-expanded={toolsOpen}
          className='text-st-fg flex min-h-11 w-full items-center gap-2 px-4 text-sm font-medium'
          type='button'
          onClick={() => setToolsOpen((open) => !open)}
        >
          {toolsOpen ? <ChevronDown className='h-4 w-4' /> : <ChevronRight className='h-4 w-4' />}
          What Claude can do ({MCP_TOOLS.length} tools)
        </button>
        {toolsOpen && (
          <ul className='border-st-line grid gap-1 border-t px-4 py-3 sm:grid-cols-2 lg:grid-cols-3'>
            {MCP_TOOLS.map((tool) => (
              <li key={tool} className='text-st-fg font-mono text-xs'>
                {tool}
              </li>
            ))}
          </ul>
        )}
      </div>

      {keys.isLoading && !keys.data && <LoadingRows rows={2} />}
      {keys.error && <ErrorNote message={describeError(keys.error)} onRetry={() => void keys.refetch()} />}
      {keys.data && keys.data.length === 0 && <p className='text-st-muted mb-3 text-sm'>No keys yet.</p>}
      {keys.data && keys.data.length > 0 && (
        <ul className='divide-st-line mb-4 flex flex-col divide-y'>
          {keys.data.map((key) => (
            <li key={key.id} className='flex min-h-12 items-center gap-3 py-2 text-sm'>
              <span className='min-w-0 flex-1'>
                <span className='text-st-fg block font-medium'>{key.name}</span>
                <span className='text-st-muted block font-mono text-xs'>
                  {key.prefix}… · created {formatRelative(key.createdAt)} ·{' '}
                  {key.lastUsedAt ? `used ${formatRelative(key.lastUsedAt)}` : 'never used'}
                </span>
              </span>
              <ActionButton
                className='min-h-9 px-3 text-xs'
                loading={revoke.isPending && revoke.variables === key.id}
                variant='danger'
                onClick={() => revoke.mutate(key.id)}
              >
                <Trash2 className='h-3.5 w-3.5' /> Revoke
              </ActionButton>
            </li>
          ))}
        </ul>
      )}

      <form
        className='border-st-line flex flex-wrap items-end gap-3 border-t pt-4'
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <Field label='Key name'>
          <input className={`${INPUT_CLASS} w-64`} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <ActionButton loading={create.isPending} type='submit' variant='primary'>
          Create key
        </ActionButton>
        {create.error && <ErrorNote message={describeError(create.error)} />}
      </form>
    </Surface>
  );
}

function UpdatesSection() {
  // Google Play build: Play updates the app, so there is nothing to check here.
  if (!SELF_UPDATE_ENABLED) return null;

  return isTauri() ? <AppUpdatesSection /> : <WebUpdatesSection />;
}

function AppUpdatesSection() {
  const update = useAppUpdate();
  const installed = update.installedVersion
    ? `Syllabi ${update.installedVersion}${update.installedSha ? ` · build ${update.installedSha}` : ''}`
    : 'Development build';
  const busy = update.phase === 'downloading' || update.phase === 'verifying';

  return (
    <Surface className='p-5'>
      <SectionTitle
        action={
          update.available ? (
            <Badge tone='accent'>Update available</Badge>
          ) : update.feed ? (
            <Badge tone='ok'>Up to date</Badge>
          ) : undefined
        }
      >
        App updates
      </SectionTitle>
      <div className='flex flex-wrap items-center justify-between gap-4'>
        <div className='min-w-0'>
          <p className='text-st-fg text-sm font-medium'>{installed}</p>
          <p className='text-st-muted text-xs'>
            {update.installedVersionCode ? `versionCode ${update.installedVersionCode} · ` : ''}
            {update.lastChecked ? `Last checked ${formatRelative(update.lastChecked)}` : 'Not checked yet'}
            {update.feed && !update.available ? ` · latest is ${update.feed.version} (build ${update.feed.sha})` : ''}
          </p>
          {update.checkError && <p className='text-st-danger text-xs'>Check failed: {update.checkError}</p>}
        </div>
        <div className='flex gap-2'>
          <ActionButton
            disabled={update.installedVersionCode === null}
            loading={update.checking}
            onClick={() => void checkForUpdates()}
          >
            <RefreshCw className='h-4 w-4' /> Check for updates
          </ActionButton>
          {update.available && (
            <ActionButton disabled={busy} variant='primary' onClick={startUpdate}>
              {canInstallInApp() ? `Update to ${update.feed?.version} (${update.feed?.sha})` : 'Download'}
            </ActionButton>
          )}
        </div>
      </div>
      {update.available && update.feed?.notes && <p className='text-st-muted mt-3 text-xs'>{update.feed.notes}</p>}
      <div className='mt-3'>
        <UpdateProgress state={update} />
      </div>
    </Surface>
  );
}

function BackendSection() {
  const settings = useBackendSettings();
  const mode = useResolvedMode();
  const [url, setUrl] = useState(settings.backendUrlOverride);
  const queryClient = useQueryClient();
  const applyUrl = () => {
    saveBackendUrlOverride(url);
    void queryClient.invalidateQueries({ queryKey: ['study'] });
  };
  const setMode = (next: MockMode) => {
    saveMockMode(next);
    void queryClient.invalidateQueries({ queryKey: ['study'] });
  };
  const liveList = LIVE_ROUTES.map((route) => route.slice(1)).join(', ');

  return (
    <Surface className='p-5'>
      <SectionTitle
        action={
          <Badge tone={mode === 'mock' ? 'warn' : mode === 'live' ? 'ok' : 'accent'}>
            {mode === 'mock'
              ? 'All mock'
              : mode === 'live'
                ? 'All live'
                : mode === 'hybrid'
                  ? 'Hybrid'
                  : 'Not resolved'}
          </Badge>
        }
      >
        Backend
      </SectionTitle>
      <div className='grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]'>
        <Field
          hint={
            getBuildTimeApiBaseUrl()
              ? `Leave empty for the built-in server (${getBuildTimeApiBaseUrl()}). Currently: ${settings.backendUrl}`
              : `Your self-hosted Syllabi server. Empty = demo mode. Currently: ${settings.backendUrl || 'demo'}`
          }
          label='API base URL'
        >
          <input
            className={`${INPUT_CLASS} font-mono`}
            placeholder={getBuildTimeApiBaseUrl() || 'https://syllabi.example.com'}
            type='url'
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        <div className='flex items-end'>
          <ActionButton onClick={applyUrl}>Apply</ActionButton>
        </div>
      </div>
      <div className='border-st-line mt-4 flex flex-wrap items-center justify-between gap-4 border-t pt-4'>
        <div className='min-w-0'>
          <p className='text-st-fg text-sm font-medium'>Data source</p>
          <p className='text-st-muted text-xs'>
            Auto (hybrid): <span className='font-mono'>{liveList}</span> come from the backend; everything the backend
            has not shipped yet is answered by the built-in mock. Force mock to work offline with sample classes.
          </p>
        </div>
        <div className='flex flex-wrap gap-2' role='group'>
          {(['auto', 'mock', 'live'] as const).map((option) => (
            <FilterChip key={option} active={settings.mockMode === option} onClick={() => setMode(option)}>
              {option === 'auto' ? 'Auto' : option === 'mock' ? 'Force mock' : 'Force live'}
            </FilterChip>
          ))}
        </div>
      </div>
    </Surface>
  );
}

export default function SettingsPage() {
  const session = useSession();
  const { backendUrl } = useBackendSettings();
  const { theme, setTheme } = useTheme();
  // next-themes has no theme during SSR; paint the picker after mount so hydration matches.
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  return (
    <>
      <Head>
        <title>Settings · Syllabi</title>
      </Head>
      <PageHeader
        actions={
          <div className='flex flex-wrap gap-2' role='group'>
            {(['light', 'dark', 'system'] as const).map((option) => (
              <FilterChip key={option} active={mounted && theme === option} onClick={() => setTheme(option)}>
                {option === 'light' ? (
                  <Sun className='h-3.5 w-3.5' />
                ) : option === 'dark' ? (
                  <Moon className='h-3.5 w-3.5' />
                ) : null}
                <span className='capitalize'>{option}</span>
              </FilterChip>
            ))}
          </div>
        }
        subtitle={
          session.state === 'signed-in'
            ? `Signed in as ${session.email || session.name || 'you'}`
            : backendUrl
              ? 'Signed out'
              : 'Demo mode'
        }
        title='Settings'
      />

      <div className='flex flex-col gap-6'>
        <AccountSection />
        <CanvasSection />
        <McpSection />
        <PhoneInboxSection />
        <RemindersSection />
        <SoundsSection />
        <ClassTimesSection />
        <NotebookPaperSection />
        <InkAutoColorSection />
        <HandwritingSection />
        {/* Which server the app talks to is set when the app is built (NEXT_PUBLIC_API / STUDY_BUILD_API), so
            people running their own server set it in their own copy. The switch only shows in local development. */}
        {process.env.NODE_ENV !== 'production' && <BackendSection />}
        <UpdatesSection />
        <UsageSection />
        <PerfLogSection />
      </div>
    </>
  );
}
