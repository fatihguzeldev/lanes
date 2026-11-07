import { CopyCommand } from './CopyCommand';
import { AgentPrompt } from './AgentPrompt';
import './SelfHosting.css';

const GUIDE = 'https://github.com/fatihguzeldev/lanes/blob/main/agents/self-hosting.md';

export function SelfHosting() {
  return (
    <section className="self-host brand-field" id="self-host" aria-labelledby="self-host-title">
      <div className="container">
        <div className="self-host__content">
          <header className="self-host__header">
            <h2 id="self-host-title">host your own lanes</h2>
            <p>deploy to your cloudflare account.</p>
            <a className="self-host__guide" href={GUIDE}>
              read the setup guide
            </a>
          </header>
          <div className="self-host__instructions">
            <CopyCommand />
            <AgentPrompt />
          </div>
        </div>
      </div>
    </section>
  );
}
