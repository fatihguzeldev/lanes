import { useState } from 'react';
import { Brand } from './Brand';
import { GitHubStars } from './github/GitHubStars';
import { WorkspaceDemo } from './demo/WorkspaceDemo';
import { SelfHosting } from './install/SelfHosting';
import './site.css';

export function App() {
  const [setupOpen, setSetupOpen] = useState(false);
  return (
    <>
      <a className="skip-link" href="#main">
        skip to content
      </a>
      <header className="site-header container">
        <a className="brand-link" href="#" aria-label="lanes home">
          <Brand />
        </a>
        <GitHubStars />
      </header>
      <main id="main" className="site-main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-layout container">
            <div className="hero__intro">
              <h1 id="hero-title">
                <span>google tasks.</span>
                <span>a little more room.</span>
              </h1>
              <div className="hero__summary">
                <p className="hero__description">a self-hosted workspace for your google tasks</p>
                <button
                  className="button button--primary"
                  type="button"
                  aria-haspopup="dialog"
                  aria-controls="self-host"
                  onClick={() => setSetupOpen(true)}
                >
                  make it yours
                </button>
              </div>
            </div>
            <div
              className="workspace-section"
              id="workspace"
              aria-label="explore the lanes workspace"
            >
              <h2 className="visually-hidden">explore the workspace</h2>
              <WorkspaceDemo suspended={setupOpen} />
            </div>
          </div>
        </section>
      </main>
      <footer className="site-footer container">
        <p>
          made by <a href="https://fatihguzel.dev">fatih güzel</a>.
        </p>
      </footer>
      <SelfHosting open={setupOpen} onClose={() => setSetupOpen(false)} />
    </>
  );
}
