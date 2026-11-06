import { useState } from 'react';
import './AccountStory.css';

const accounts = {
  personal: {
    name: 'Personal',
    tasks: [
      ['Find a trail for Saturday', 'Weekend plans'],
      ['Book a table for two', 'Weekend plans'],
      ['Pick up the library books', 'Life admin'],
      ['Plan the week over coffee', 'Life admin'],
    ],
  },
  work: {
    name: 'Work',
    tasks: [
      ['Polish the welcome screen', 'Product launch'],
      ['Write the launch notes', 'Product launch'],
      ['Follow up on feedback', 'Notes to follow up'],
      ['Review the next small thing', 'Notes to follow up'],
    ],
  },
} as const;

export function AccountStory() {
  const [selected, setSelected] = useState<keyof typeof accounts>('personal');
  const account = accounts[selected];

  return (
    <section className="account-story container" aria-labelledby="accounts-title">
      <div className="account-story__intro">
        <h2 id="accounts-title">Each account in its own lane.</h2>
        <p>Switch between your Google accounts. Keep their tasks and organization separate.</p>
      </div>
      <div className="account-story__workspace">
        <div className="account-story__switcher" role="group" aria-label="Sample accounts">
          {(['personal', 'work'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className="account-story__account"
              aria-pressed={selected === key}
              onClick={() => setSelected(key)}
            >
              <span className="account-story__avatar" aria-hidden="true">
                {accounts[key].name[0]}
              </span>
              <span>
                <strong>{accounts[key].name}</strong>
              </span>
              <span className="account-story__selection" aria-hidden="true">
                {selected === key ? 'Selected' : 'Switch account'}
              </span>
            </button>
          ))}
        </div>
        <div className="account-story__lists" aria-live="polite" aria-atomic="true">
          <ul key={selected} aria-label={`${account.name} sample tasks`}>
            {account.tasks.map(([title, list]) => (
              <li key={title}>
                <span className="account-story__circle" aria-hidden="true" />
                <span>{title}</span>
                <span className="account-story__list-name">{list}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="account-story__caption">Sample accounts.</p>
    </section>
  );
}
