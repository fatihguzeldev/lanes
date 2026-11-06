import { CopyCommand } from './CopyCommand';
import './SelfHosting.css';

const GUIDE = 'https://github.com/fatihguzeldev/lanes/blob/main/agents/self-hosting.md';

export function SelfHosting() {
  return (
    <section className="self-host-section" id="self-host" aria-labelledby="self-host-title">
      <div className="self-host-layout container">
        <div className="self-host-intro">
          <h2 id="self-host-title">A Lanes of your own.</h2>
          <p>Host Lanes in your Cloudflare account.</p>
          <a className="button self-host-button" href={GUIDE}>
            Read the setup guide
          </a>
          <p className="self-host-license">Open source. MIT licensed.</p>
        </div>
        <div className="self-host-instructions">
          <p className="self-host-instructions__lead">Start with the source.</p>
          <CopyCommand />
          <p className="self-host-instructions__prompt-label">Then ask your coding agent:</p>
          <blockquote className="install-prompt">
            Deploy Lanes to my Cloudflare account. Follow <code>AGENTS.md</code> and{' '}
            <code>agents/self-hosting.md</code>.
          </blockquote>
          <p className="self-host-instructions__note">You handle Google sign-in and consent.</p>
        </div>
        <div className="self-host-footnotes">
          <p>Cloudflare free-plan quotas apply.</p>
          <p>Google testing mode requires reconnection every seven days.</p>
        </div>
      </div>
    </section>
  );
}
