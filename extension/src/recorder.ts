/**
 * Recording what a person does in a tab. Arming a tab installs the page-side recorder (extension/src/page/recorder.ts)
 * in the engine world of every document — now (runImmediately) and in every later one, including out-of-process
 * iframes as they attach — and scopes the RECORD_BINDING to that world, so page scripts can neither see nor forge it.
 * Each report arrives here as Runtime.bindingCalled and is buffered with the browser signals a script needs
 * (navigation, popup, download, dialog). Popups opened from a recorded tab are recorded too.
 * While the agent itself drives a recorded tab (act, navigate, history), nothing is recorded: the recording is the
 * person's demonstration, and the agent's own steps are already in the session script.
 */
import type { RecordEvent, RecordStatus } from '../../src/protocol.js';
import { PAGE_GLOBAL, RECORD_BINDING, type RecordedAction } from '../../src/shared/page-contract.js';
import { INJECTED_SOURCE } from '../../src/shared/injected-source';
import { installEngineJs } from '../../src/shared/engine';
import * as executor from './cdp';
import * as identity from './identity';
import { SessionError } from './sessions';
import { WORLD_NAME, callPage, pageModuleSource } from './world';

type EventBody = RecordEvent extends infer E ? E extends RecordEvent ? Omit<E, 'seq' | 'tabId' | 'page' | 'ts'> : never : never;

interface ArmedTab { scriptId?: string; /** OOPIF sessionId → its script identifier */ frames: Map<string, string>; closed?: boolean }
interface Recording { root: number; tabs: Map<number, ArmedTab>; events: RecordEvent[]; seq: number; startedAt: number; interrupted?: string; dropped: number }

const MAX_EVENTS = 5000;
/** Agent commands still settle after they return: late events of the page's reaction are the agent's too. */
const AGENT_GRACE_MS = 400;

const byTab = new Map<number, Recording>();
const agentDepth = new Map<number, number>();
const agentUntil = new Map<number, number>();

function agentBusy(tabId: number): boolean { return (agentDepth.get(tabId) ?? 0) > 0 || Date.now() < (agentUntil.get(tabId) ?? 0); }

/** Run an agent command on a tab without recording what it causes. */
export async function asAgent<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  if (!byTab.has(tabId)) return fn();
  agentDepth.set(tabId, (agentDepth.get(tabId) ?? 0) + 1);
  try { return await fn(); } finally {
    agentDepth.set(tabId, (agentDepth.get(tabId) ?? 1) - 1);
    agentUntil.set(tabId, Date.now() + AGENT_GRACE_MS);
  }
}

function push(rec: Recording, tabId: number, body: EventBody): void {
  rec.events.push({ ...body, seq: ++rec.seq, tabId, ts: Date.now() } as RecordEvent);
  if (rec.events.length > MAX_EVENTS) { const n = rec.events.length - MAX_EVENTS; rec.events.splice(0, n); rec.dropped += n; }
}

let script: Promise<string> | null = null;
/** Installs the engine (if this world has none yet) and starts the page recorder. */
function recorderScript(): Promise<string> {
  script ??= pageModuleSource().then((page) => `${installEngineJs(INJECTED_SOURCE, page)};globalThis.${PAGE_GLOBAL}.recordStart();`);
  return script;
}

/** Binding + new-document script on one CDP session (the tab's root session or an OOPIF child session). */
async function armSession(target: chrome.debugger.Debuggee): Promise<string> {
  await executor.sendDebuggerCommand(target, 'Runtime.addBinding', { name: RECORD_BINDING, executionContextName: WORLD_NAME }, 5_000);
  const { identifier } = await executor.sendDebuggerCommand(target, 'Page.addScriptToEvaluateOnNewDocument', { source: await recorderScript(), worldName: WORLD_NAME, runImmediately: true }, 15_000) as { identifier: string };
  return identifier;
}
async function disarmSession(target: chrome.debugger.Debuggee, scriptId: string | undefined): Promise<void> {
  if (scriptId) await executor.sendDebuggerCommand(target, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }, 3_000).catch(() => {});
  // stops Runtime.bindingCalled for this session; listeners left in live documents report into nothing
  await executor.sendDebuggerCommand(target, 'Runtime.removeBinding', { name: RECORD_BINDING }, 3_000).catch(() => {});
}

async function armFrame(rec: Recording, tabId: number, sessionId: string): Promise<void> {
  const armed = rec.tabs.get(tabId);
  if (!armed || armed.frames.has(sessionId)) return;
  armed.frames.set(sessionId, '');
  const target = { tabId, sessionId } as chrome.debugger.Debuggee;
  try {
    await executor.sendDebuggerCommand(target, 'Runtime.enable', undefined, 3_000).catch(() => {});
    armed.frames.set(sessionId, await armSession(target));
  } catch { armed.frames.delete(sessionId); /* the frame went away while arming */ }
}

async function armTab(rec: Recording, tabId: number): Promise<void> {
  // attach first: a stale attachment is detached and re-attached, and that detach must not count as an interruption
  await executor.ensureAttached(tabId, true);
  const armed: ArmedTab = { frames: new Map() };
  rec.tabs.set(tabId, armed);
  byTab.set(tabId, rec);
  armed.scriptId = await armSession({ tabId });
  // runImmediately covers loaded documents; make sure the main frame is armed before start returns
  await callPage(tabId, null, 'recordStart', undefined, true, 15_000).catch(() => {});
  for (const f of executor.oopifSessions(tabId)) await armFrame(rec, tabId, f.sessionId);
}

async function withPages(events: RecordEvent[]): Promise<RecordEvent[]> {
  const ids = new Map<number, string | undefined>();
  const pageOf = async (tabId: number) => { if (!ids.has(tabId)) ids.set(tabId, await identity.resolveTargetId(tabId).catch(() => undefined)); return ids.get(tabId); };
  const out: RecordEvent[] = [];
  for (const e of events) {
    const page = await pageOf(e.tabId);
    const childPage = e.type === 'popup' ? await pageOf(e.childTabId) : undefined;
    out.push({ ...e, ...(page && { page }), ...(childPage && { childPage }) } as RecordEvent);
  }
  return out;
}

async function status(rec: Recording, recording: boolean, after = 0, limit = MAX_EVENTS): Promise<RecordStatus> {
  const pending = rec.events.filter((e) => e.seq > after);
  const page = pending.slice(0, limit);
  return {
    recording, tabs: [...rec.tabs.keys()], startedAt: rec.startedAt,
    cursor: page.length ? page[page.length - 1].seq : Math.max(after, rec.seq - pending.length),
    events: await withPages(page), ...(pending.length > limit && { hasMore: true }),
    ...(rec.interrupted && { interrupted: rec.interrupted }), ...(rec.dropped && { dropped: rec.dropped }),
  } as RecordStatus;
}

function recordingOf(tabId: number): Recording {
  const rec = byTab.get(tabId);
  if (!rec) throw new SessionError('no_recording', `tab ${tabId} is not being recorded`, 'Start one with record_start on this tab.');
  return rec;
}

export async function start(tabId: number, opts: { focus?: boolean } = {}): Promise<RecordStatus> {
  if (byTab.has(tabId)) throw new SessionError('recording_active', `tab ${tabId} is already being recorded`, 'Call record_stop on it first.');
  const rec: Recording = { root: tabId, tabs: new Map(), events: [], seq: 0, startedAt: Date.now(), dropped: 0 };
  try { await armTab(rec, tabId); } catch (err) { for (const t of rec.tabs.keys()) byTab.delete(t); throw err; }
  if (opts.focus !== false) {
    const t = await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
    if (t?.windowId !== undefined) await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
  }
  return status(rec, true);
}

export async function read(tabId: number, afterSequence = 0, limit = 500): Promise<RecordStatus> {
  return status(recordingOf(tabId), true, afterSequence, Math.max(1, Math.min(limit, MAX_EVENTS)));
}

export async function stop(tabId: number): Promise<RecordStatus> {
  const rec = recordingOf(tabId);
  for (const [t, armed] of rec.tabs) {
    byTab.delete(t);
    if (armed.closed) continue;
    await disarmSession({ tabId: t }, armed.scriptId);
    for (const [sessionId, id] of armed.frames) await disarmSession({ tabId: t, sessionId } as chrome.debugger.Debuggee, id);
    await callPage(t, null, 'recordStop', undefined, true, 3_000).catch(() => {});
  }
  return status(rec, false);
}

export function isRecording(tabId: number): boolean { return byTab.has(tabId); }

/** Call once at startup. */
export function registerRecorderListeners(): void {
  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    const tabId = source.tabId;
    if (!tabId) return;
    const rec = byTab.get(tabId);
    if (!rec) return;
    if (method === 'Runtime.bindingCalled') {
      if (params?.name !== RECORD_BINDING || agentBusy(tabId)) return;
      let action: RecordedAction;
      try { action = JSON.parse(String(params.payload)) as RecordedAction; } catch { return; }
      if (!action || typeof action.selector !== 'string' || typeof action.name !== 'string') return;
      push(rec, tabId, { type: 'action', action });
      return;
    }
    if (agentBusy(tabId)) return;
    const sessionId = (source as { sessionId?: string }).sessionId;
    if (method === 'Page.frameNavigated' && !sessionId && !params?.frame?.parentId && typeof params?.frame?.url === 'string') push(rec, tabId, { type: 'navigation', url: params.frame.url });
    else if (method === 'Page.downloadWillBegin') push(rec, tabId, { type: 'download', url: String(params?.url ?? ''), ...(params?.suggestedFilename && { suggestedFilename: String(params.suggestedFilename) }) });
    else if (method === 'Page.javascriptDialogOpening') push(rec, tabId, { type: 'dialog', dialogType: String(params?.type ?? 'alert'), message: String(params?.message ?? '').slice(0, 500) });
    else if (method === 'Page.javascriptDialogClosed') {
      const open = [...rec.events].reverse().find((e) => e.type === 'dialog' && e.tabId === tabId && e.accepted === undefined);
      if (open && open.type === 'dialog') { open.accepted = Boolean(params?.result); if (open.dialogType === 'prompt' && open.accepted && typeof params?.userInput === 'string') open.promptText = params.userInput; }
    }
  });
  executor.onOopifAttached((tabId, sessionId) => { const rec = byTab.get(tabId); if (rec) void armFrame(rec, tabId, sessionId); });
  chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
    const rec = byTab.get(d.sourceTabId);
    if (!rec || byTab.has(d.tabId) || agentBusy(d.sourceTabId)) return;
    push(rec, d.sourceTabId, { type: 'popup', childTabId: d.tabId, url: d.url });
    void armTab(rec, d.tabId).catch((err) => { rec.tabs.delete(d.tabId); byTab.delete(d.tabId); console.warn(`[opencli-mcp] popup ${d.tabId} could not be recorded: ${String(err)}`); });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    const armed = byTab.get(tabId)?.tabs.get(tabId);
    if (armed) armed.closed = true;
    agentDepth.delete(tabId); agentUntil.delete(tabId);
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (!source.tabId || (source as { sessionId?: string }).sessionId) return;
    const rec = byTab.get(source.tabId);
    // the debugger was detached (the user cancelled the infobar, or the tab closed): nothing more can be recorded there
    if (rec && !rec.tabs.get(source.tabId)?.closed) rec.interrupted = `debugger detached from tab ${source.tabId} (${reason})`;
  });
}
