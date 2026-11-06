import { Brand } from './Brand';
import { GitHubStars } from './github/GitHubStars';
import { WorkspaceDemo } from './demo/WorkspaceDemo';
import { TaskDetails } from './details/TaskDetails';
import { AccountStory } from './accounts/AccountStory';
import { SelfHosting } from './install/SelfHosting';
import './site.css';

export const REPOSITORY = 'https://github.com/fatihguzeldev/lanes';

export function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header container">
        <a className="brand-link" href="#" aria-label="Lanes home">
          <Brand />
        </a>
        <nav className="site-nav" aria-label="Main navigation">
          <a href="#workspace">The workspace</a>
          <a href="#self-host">Make it yours</a>
        </nav>
        <GitHubStars />
      </header>
      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero__intro container">
            <h1 id="hero-title">
              <span>Google Tasks.</span>
              <span>A little more room.</span>
            </h1>
            <p className="hero__description">A self-hosted home for your Google Tasks.</p>
            <div className="hero__actions">
              <a className="button button--primary" href="#self-host">
                Make it yours
              </a>
              <a className="text-link" href="#workspace">
                Take a look around
              </a>
            </div>
          </div>
          <div
            className="workspace-section container"
            id="workspace"
            aria-label="Explore the Lanes workspace"
          >
            <h2 className="visually-hidden">Explore the workspace</h2>
            <figure className="workspace-figure">
              <figcaption className="preview-notice">
                <span>Interactive preview</span>
                <span>Sample tasks. No sign-in.</span>
              </figcaption>
              <WorkspaceDemo />
              <p className="workspace-caption">
                Change the view. Check something off. Make yourself at home.
              </p>
            </figure>
          </div>
        </section>
        <TaskDetails />
        <AccountStory />
        <SelfHosting />
      </main>
      <footer className="site-footer container">
        <a className="brand-link" href="#" aria-label="Lanes home">
          <Brand />
        </a>
        <p>
          Made by <a href="https://fatihguzel.dev">Fatih Güzel</a>.
        </p>
        <a href={REPOSITORY}>Source on GitHub</a>
      </footer>
    </>
  );
}
