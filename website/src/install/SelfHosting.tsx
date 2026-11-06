import { CopyCommand } from './CopyCommand';
import './SelfHosting.css';

const GUIDE = 'https://github.com/fatihguzeldev/lanes/blob/main/agents/self-hosting.md';

export function SelfHosting() {
  return (
    <section className="self-host-section" id="self-host" aria-labelledby="self-host-title">
      <div className="self-host-layout container">
        <div className="self-host-intro">
          <h2 id="self-host-title">a lanes of your own.</h2>
          <p>host lanes in your cloudflare account.</p>
          <a className="button self-host-button" href={GUIDE}>
            read the setup guide
          </a>
          <p className="self-host-license">open source. mit licensed.</p>
        </div>
        <div className="self-host-instructions">
          <p className="self-host-instructions__lead">start with the source.</p>
          <CopyCommand />
          <p className="self-host-instructions__prompt-label">then ask your coding agent:</p>
          <blockquote className="install-prompt">
            deploy lanes to my cloudflare account. follow <code>AGENTS.md</code> and{' '}
            <code>agents/self-hosting.md</code>.
          </blockquote>
          <p className="self-host-instructions__note">you handle google sign-in and consent.</p>
        </div>
        <div className="self-host-footnotes">
          <p>cloudflare free-plan quotas apply.</p>
          <p>google testing mode requires reconnection every seven days.</p>
        </div>
      </div>
    </section>
  );
}
