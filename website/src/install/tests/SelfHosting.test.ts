import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SelfHosting } from '../SelfHosting';
import { AGENT_PROMPT, CLONE_COMMAND } from '../copy-command';

describe('in-page self hosting', () => {
  it('exposes setup and both copyable instructions in the normal page flow', () => {
    const markup = renderToStaticMarkup(createElement(SelfHosting));

    expect(markup).toMatch(/<section[^>]*id="self-host"[^>]*aria-labelledby="self-host-title"/);
    expect(markup).toContain('id="self-host-title"');
    expect(markup).toContain(CLONE_COMMAND);
    expect(markup).toContain(AGENT_PROMPT);
    expect(markup).toContain('aria-label="copy clone command"');
    expect(markup).toContain('aria-label="copy setup prompt"');
    expect(markup).toContain(
      'href="https://github.com/fatihguzeldev/lanes/blob/main/agents/self-hosting.md"',
    );
    expect(markup).not.toMatch(/<dialog|<textarea|<input|close setup/);
  });
});
