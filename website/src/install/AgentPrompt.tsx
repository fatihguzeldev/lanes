import { CopyButton } from './CopyButton';
import { AGENT_PROMPT } from './copy-command';

export function AgentPrompt() {
  return (
    <div className="agent-prompt-section">
      <label className="agent-prompt-label" htmlFor="setup-prompt">
        then ask your coding agent:
      </label>
      <div className="agent-prompt">
        <textarea id="setup-prompt" value={AGENT_PROMPT} readOnly rows={4} spellCheck={false} />
        <div className="agent-prompt__actions">
          <span>codex / claude code</span>
          <CopyButton key={AGENT_PROMPT} text={AGENT_PROMPT} label="copy setup prompt" />
        </div>
      </div>
    </div>
  );
}
