/**
 * Page-side recorder: turns what a person does in this frame into RecordedAction JSON and reports it through the
 * RECORD_BINDING (Runtime.addBinding, visible only in the engine world). Event semantics follow Playwright's
 * lightweight recorder (JsonRecordActionTool): listen in the capture phase, never consume or change an event, and
 * name each target with Playwright's own selector generator — the same one act and find use — so a recorded step
 * replays through tab_act unchanged. Only trusted (real user or CDP input) events are recorded.
 */
import { RECORD_BINDING, type Locators, type RecordedAction } from '../../../src/shared/page-contract.js';

export interface RecorderDeps {
  replaySelector(el: Element, opts?: { noText?: boolean }): string | null;
  locatorsOf(selector: string): Locators;
  isSecretField(el: Element): boolean;
}

type Draft = Omit<RecordedAction, 'selector' | 'locator' | 'ts' | 'frame' | 'frameUrl'>;

// Non-text inputs that open native pickers: their click is not the action, their input event is.
const NATIVE_PICKERS = new Set(['color', 'date', 'datetime-local', 'file', 'month', 'range', 'time', 'week']);

function modifiersOf(e: MouseEvent | KeyboardEvent): number { return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0); }
function asToggle(n: Element | null): HTMLInputElement | null { return n instanceof HTMLInputElement && (n.type === 'checkbox' || n.type === 'radio') ? n : null; }
function isEditable(el: Element): boolean { return el.nodeName === 'INPUT' || el.nodeName === 'TEXTAREA' || (el as HTMLElement).isContentEditable; }
/** The innermost element the event started at, through open shadow roots. */
function deepTarget(e: Event): Element | null {
  for (const n of e.composedPath()) if (n instanceof Element) return n;
  return null;
}

/** Index path of this frame from the top document; null when a cross-origin ancestor hides its frame element. */
function framePath(): { frame?: number[] | null; frameUrl?: string } {
  if (window.top === window) return {};
  const path: number[] = [];
  try {
    let w: Window = window;
    while (w !== w.top) {
      const fe = w.frameElement;
      if (!fe) return { frame: null, frameUrl: location.href };
      path.unshift([...fe.ownerDocument.querySelectorAll('iframe,frame')].indexOf(fe));
      w = w.parent;
    }
    return { frame: path, frameUrl: location.href };
  } catch { return { frame: null, frameUrl: location.href }; }
}

export function createRecorder(deps: RecorderDeps) {
  let listeners: Array<() => void> = [];

  const emit = (el: Element, draft: Draft, opts: { noText?: boolean } = {}): void => {
    const report = (globalThis as Record<string, unknown>)[RECORD_BINDING];
    if (typeof report !== 'function') return; // the binding is gone: recording stopped for this tab
    const selector = deps.replaySelector(el, opts);
    if (!selector) return;
    const action: RecordedAction = { ...draft, selector, locator: deps.locatorsOf(selector), ts: Date.now(), ...framePath() };
    try { (report as (payload: string) => void)(JSON.stringify(action)); } catch { /* binding detached mid-navigation */ }
  };

  const onClick = (e: MouseEvent): void => {
    if (!e.isTrusted) return;
    const el = deepTarget(e);
    if (!el) return;
    if (e.type === 'auxclick' && e.button !== 1) return; // right button is recorded from contextmenu
    if (el.nodeName === 'SELECT' || el.nodeName === 'OPTION') return;
    if (el instanceof HTMLInputElement && NATIVE_PICKERS.has(el.type)) return;
    // the frame's own recorder reports what was clicked inside it; a click that lands on the <iframe> box is not an action
    if (el.nodeName === 'IFRAME' || el.nodeName === 'FRAME') return;
    const toggle = asToggle(el);
    // The input's own click (from the label, the mouse or the space bar) records the check; the label click would repeat it.
    if (!toggle && el.closest('label') && asToggle((el.closest('label') as HTMLLabelElement).control)) return;
    // inside the click handler the toggle already shows its new state
    if (toggle) { emit(toggle, { name: toggle.checked ? 'check' : 'uncheck' }); return; }
    emit(el, { name: 'click', button: e.button === 1 ? 'middle' : 'left', modifiers: modifiersOf(e), clickCount: Math.max(1, e.detail) });
  };

  const onContextMenu = (e: MouseEvent): void => {
    if (!e.isTrusted) return;
    const el = deepTarget(e);
    if (el) emit(el, { name: 'click', button: 'right', modifiers: modifiersOf(e), clickCount: 1 });
  };

  const onInput = (e: Event): void => {
    if (!e.isTrusted) return;
    const el = deepTarget(e);
    if (!el) return;
    if (el instanceof HTMLInputElement && el.type === 'file') { emit(el, { name: 'setInputFiles', files: [...(el.files ?? [])].map((f) => f.name) }); return; }
    if (el instanceof HTMLSelectElement) { emit(el, { name: 'select', options: [...el.selectedOptions].map((o) => o.value) }); return; }
    if (asToggle(el)) return; // recorded from its click
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const secret = deps.isSecretField(el);
      emit(el, { name: 'fill', ...(secret ? { secret: true, text: '' } : { text: el.value }) });
      return;
    }
    if ((el as HTMLElement).isContentEditable) {
      // by now the element holds the new text: name it without that text so the locator still matches before the fill
      emit(el, { name: 'fill', text: (el as HTMLElement).innerText }, { noText: true });
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!e.isTrusted || typeof e.key !== 'string') return; // IME and autofill send keydowns without a key
    const el = deepTarget(e);
    if (!el) return;
    if (!shouldRecordKey(e, el)) return;
    emit(el, { name: 'press', key: e.key, modifiers: modifiersOf(e) });
  };

  return {
    start(): boolean {
      if (listeners.length) return false;
      const on = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void) => {
        const h = (e: Event) => { try { fn(e as DocumentEventMap[K]); } catch { /* never break the page */ } };
        document.addEventListener(type, h, true);
        listeners.push(() => document.removeEventListener(type, h, true));
      };
      on('click', onClick);
      on('auxclick', onClick);
      on('contextmenu', onContextMenu);
      on('input', onInput);
      on('keydown', onKeyDown);
      return true;
    },
    stop(): boolean {
      const was = listeners.length > 0;
      for (const off of listeners) off();
      listeners = [];
      return was;
    },
    active(): boolean { return listeners.length > 0; },
  };
}

/** Which keydowns are actions of their own: text typing, Backspace/Delete and paste arrive as the input's fill. */
function shouldRecordKey(e: KeyboardEvent, el: Element): boolean {
  if (e.key === 'Enter' && (el.nodeName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)) return false;
  if (['Backspace', 'Delete', 'AltGraph', 'Shift', 'Control', 'Meta', 'Alt', 'Process', 'Dead', 'Unidentified'].includes(e.key)) return false;
  if (e.key === ' ' && asToggle(el)) return false; // the toggle's click records the check
  if (e.key === '@' && e.code === 'KeyL') return false; // macOS QWERTZ at-sign
  const mac = navigator.platform.includes('Mac');
  if (e.key.toLowerCase() === 'v' && (mac ? e.metaKey : e.ctrlKey)) return false; // paste lands as a fill
  if (!mac && e.key === 'Insert' && e.shiftKey) return false;
  const withModifier = e.ctrlKey || e.altKey || e.metaKey;
  if (e.key.length === 1 && !withModifier) return !isEditable(el);
  return true;
}
