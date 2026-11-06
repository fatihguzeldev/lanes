import { CopyCommand } from './CopyCommand';
import { AgentPrompt } from './AgentPrompt';
import './SelfHosting.css';

const GUIDE = 'https://github.com/fatihguzeldev/lanes/blob/main/agents/self-hosting.md';

export function SelfHosting() {
  return (
    <section className="self-host-section" id="self-host" aria-labelledby="self-host-title">
      <div className="self-host-layout container">
        <div className="self-host-intro">
          <h2 id="self-host-title">host your own lanes</h2>
          <p>deploy to your cloudflare account.</p>
          <a className="button button--primary self-host-button" href={GUIDE}>
            read the setup guide
          </a>
        </div>
        <div className="self-host-instructions">
          <CopyCommand />
          <AgentPrompt />
        </div>
      </div>
    </section>
  );
}
