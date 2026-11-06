import { CopyButton } from './CopyButton';
import { AGENT_PROMPT } from './copy-command';

export function AgentPrompt() {
  return (
    <div className="agent-prompt-section">
      <p className="agent-prompt-label">then ask your coding agent:</p>
      <div className="agent-prompt">
        <p id="setup-prompt" className="agent-prompt__text">
          {AGENT_PROMPT}
        </p>
        <div className="agent-prompt__actions">
          <CopyButton key={AGENT_PROMPT} text={AGENT_PROMPT} label="copy setup prompt" />
        </div>
      </div>
    </div>
  );
}
