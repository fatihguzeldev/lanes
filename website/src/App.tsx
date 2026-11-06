import { Brand } from './Brand';
import { GitHubStars } from './github/GitHubStars';
import { WorkspaceDemo } from './demo/WorkspaceDemo';
import { SelfHosting } from './install/SelfHosting';
import './site.css';

export const REPOSITORY = 'https://github.com/fatihguzeldev/lanes';

export function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        skip to content
      </a>
      <div className="site-header-field">
        <header className="site-header container">
          <a className="brand-link" href="#" aria-label="lanes home">
            <Brand />
          </a>
          <nav className="site-nav" aria-label="main navigation">
            <a href="#self-host">self-host</a>
          </nav>
          <GitHubStars />
        </header>
      </div>
      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero__intro container">
            <h1 id="hero-title">
              <span>google tasks.</span>
              <span>a little more room.</span>
            </h1>
            <div className="hero__summary">
              <p className="hero__description">a self-hosted workspace for your google tasks</p>
              <a className="button button--primary" href="#self-host">
                make it yours
              </a>
            </div>
          </div>
          <div
            className="workspace-section container"
            id="workspace"
            aria-label="explore the lanes workspace"
          >
            <h2 className="visually-hidden">explore the workspace</h2>
            <WorkspaceDemo />
          </div>
        </section>
        <SelfHosting />
      </main>
      <footer className="site-footer container">
        <a className="brand-link" href="#" aria-label="lanes home">
          <Brand />
        </a>
        <p>
          made by <a href="https://fatihguzel.dev">fatih güzel</a>.
        </p>
        <a href={REPOSITORY}>source on github</a>
      </footer>
    </>
  );
}
