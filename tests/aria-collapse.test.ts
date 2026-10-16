import { describe, expect, it } from 'vitest';
import { collapseAria } from '../src/shared/aria-collapse.js';

describe('action map compression', () => {
  it('preserves editors and focus outside a large history branch', () => {
    const history = Array.from({ length: 100 }, (_, n) => `    - generic [ref=e${n + 10}]: ${'history '.repeat(20)}`).join('\n');
    const state = `- generic [ref=e1]:\n  - generic [ref=e2]:\n${history}\n  - textbox "Scene" [ref=e500]\n  - button "Create" [ref=e501]\nFocused: [ref=e500]`;
    const out = collapseAria(state, 1200);
    expect(out.collapsed).toBe(true);
    expect(out.text).toContain('textbox "Scene" [ref=e500]');
    expect(out.text).toContain('Focused: [ref=e500]');
    expect(out.text).toContain('[ref=e2]: (collapsed)');
  });

  it('keeps a focused button in a branch containing many noninteractive records', () => {
    const state = `- generic [ref=e1]:\n  - generic [ref=e2]:\n${Array.from({ length: 80 }, (_, n) => `    - generic [ref=e${n + 10}]: ${'entry '.repeat(30)}`).join('\n')}\n  - button "Open editor" [ref=e900]\nFocused: [ref=e900]`;
    expect(collapseAria(state, 1000).text).toContain('button "Open editor" [ref=e900]');
  });
});
