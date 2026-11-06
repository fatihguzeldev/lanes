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
        skip to content
      </a>
      <div className="site-header-field">
        <header className="site-header container">
          <a className="brand-link" href="#" aria-label="lanes home">
            <Brand />
          </a>
          <nav className="site-nav" aria-label="main navigation">
            <a href="#workspace">the workspace</a>
            <a href="#self-host">make it yours</a>
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
            <p className="hero__description">a self-hosted home for your google tasks.</p>
            <div className="hero__actions">
              <a className="button button--primary" href="#self-host">
                make it yours
              </a>
              <a className="text-link" href="#workspace">
                take a look around
              </a>
            </div>
          </div>
          <div
            className="workspace-section container"
            id="workspace"
            aria-label="explore the lanes workspace"
          >
            <h2 className="visually-hidden">explore the workspace</h2>
            <figure className="workspace-figure">
              <figcaption className="preview-notice">
                <span>interactive preview</span>
                <span>sample tasks. no sign-in.</span>
              </figcaption>
              <WorkspaceDemo />
              <p className="workspace-caption">
                change the view. check something off. make yourself at home.
              </p>
            </figure>
          </div>
        </section>
        <TaskDetails />
        <AccountStory />
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
