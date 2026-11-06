import { CopyCommand } from './CopyCommand';
import { AgentPrompt } from './AgentPrompt';
import './SelfHosting.css';

const GUIDE = 'https://github.com/fatihguzeldev/lanes/blob/main/agents/self-hosting.md';

export function SelfHosting() {
  return (
    <section className="self-host" id="self-host" aria-labelledby="self-host-title">
      <div className="container">
        <div className="self-host__content">
          <header className="self-host__header">
            <h2 id="self-host-title">host your own lanes</h2>
            <p>deploy to your cloudflare account.</p>
          </header>
          <div className="self-host__instructions">
            <CopyCommand />
            <AgentPrompt />
          </div>
          <footer className="self-host__footer">
            <a href={GUIDE}>read the setup guide</a>
          </footer>
        </div>
      </div>
    </section>
  );
}
