import { CopyButton } from './CopyButton';
import { CLONE_COMMAND } from './copy-command';
import './copy-command.css';

export function CopyCommand() {
  return (
    <div className="copy-command">
      <code className="copy-command__text">{CLONE_COMMAND}</code>
      <CopyButton key={CLONE_COMMAND} text={CLONE_COMMAND} label="copy clone command" />
    </div>
  );
}
