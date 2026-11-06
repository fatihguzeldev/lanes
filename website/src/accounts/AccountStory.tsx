import { useState } from 'react';
import './AccountStory.css';

const accounts = {
  personal: {
    board: 'life, lately',
    lists: [
      {
        name: 'weekend plans',
        tasks: ['find a trail for saturday', 'book a table for two', 'take the long way home'],
      },
      {
        name: 'life admin',
        tasks: ['pick up the library books', 'renew the passport', 'plan the week over coffee'],
      },
    ],
  },
  work: {
    board: 'the next release',
    lists: [
      {
        name: 'in progress',
        tasks: [
          'polish the welcome screen',
          'write the launch notes',
          'record a short walkthrough',
        ],
      },
      {
        name: 'follow up',
        tasks: [
          'read through the feedback',
          'check the release checklist',
          'send a thank-you note',
        ],
      },
    ],
  },
} as const;

function AccountIcon({ work = false }: { work?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path
        d={
          work
            ? 'M4 7h16v13H4ZM8 7V4h8v3M4 12h16M10 12v2h4v-2'
            : 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2'
        }
      />
    </svg>
  );
}

export function AccountStory() {
  const [selected, setSelected] = useState<keyof typeof accounts>('personal');
  const [completed, setCompleted] = useState<Record<string, boolean>>({});
  const account = accounts[selected];

  return (
    <section className="account-story container" aria-labelledby="accounts-title">
      <header className="account-story__intro">
        <h2 id="accounts-title">each account in its own lane.</h2>
        <p>switch google accounts without mixing their tasks.</p>
      </header>
      <div className="account-story__workspace product-preview">
        <div className="account-story__toolbar">
          <div className="account-story__switcher" role="group" aria-label="google accounts">
            {(['personal', 'work'] as const).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={selected === key}
                onClick={() => setSelected(key)}
              >
                <AccountIcon work={key === 'work'} />
                {key}
              </button>
            ))}
          </div>
          <p className="account-story__board-name">
            <span className="account-story__board-symbol">
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M4 5h6v14H4ZM14 5h6v9h-6Z" />
              </svg>
            </span>
            {account.board}
          </p>
        </div>
        <div className="account-story__lists" aria-live="polite">
          {account.lists.map((list) => (
            <section className="account-story__list" key={list.name} aria-label={list.name}>
              <h3>{list.name}</h3>
              <ul>
                {list.tasks.map((title) => {
                  const id = `${selected}-${title}`;
                  return (
                    <li key={id}>
                      <label className="account-story__task">
                        <input
                          type="checkbox"
                          checked={!!completed[id]}
                          onChange={(event) =>
                            setCompleted((current) => ({ ...current, [id]: event.target.checked }))
                          }
                        />
                        <span className="account-story__check" aria-hidden="true">
                          <svg
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                          >
                            <path d="m3 8 3 3 7-7" />
                          </svg>
                        </span>
                        <span>{title}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
