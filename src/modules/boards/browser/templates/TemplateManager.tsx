import { useRef, useState, type FormEvent } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import { BoardTemplateSummarySchema } from '../../contracts/template';
import { TemplateCommandSchema, type TemplateCommand } from '../../contracts/template-commands';
import { ListTemplateSummarySchema } from '../../../tasks/contracts/template';
import { accountToday } from '../../../tasks/model/planning';
import { Dialog } from '../../../../shared/ui/dialog/Dialog';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { request } from '../../../../shared/browser/http/http';
import {
  type PersonalTemplate,
  type Mutate,
  baseFor,
  errorMessage,
  localWritable,
  providerWritable,
} from './template-model';
import { type TemplateWorkspaceProps } from './TemplateWorkspace';
import { useLifetime, useDirty, CloseGuard } from './TemplateDraft';
import { ServerRecovery } from './TemplateFeedback';
import { SourceCounts, SnapshotContent } from './TemplateSource';

export function TemplateManager({
  account,
  template,
  draft,
  mutate,
  error,
  onClose,
  onApplied,
  onReplace,
  onSchedule,
  onDirtyChange,
}: {
  account: ConnectionSummary;
  template: PersonalTemplate;
  draft?: TemplateCommand | undefined;
  mutate: Mutate;
  error: string;
  onClose: () => void;
  onApplied: (template: PersonalTemplate) => void;
  onReplace: (template: PersonalTemplate) => void;
  onSchedule: (template: PersonalTemplate) => void;
  onDirtyChange: TemplateWorkspaceProps['onDirtyChange'];
}) {
  const retained =
    draft?.kind === 'template.list.update' || draft?.kind === 'template.board.update'
      ? draft.input
      : null;
  const [baseline, setBaseline] = useState(template),
    [name, setName] = useState(retained?.name ?? template.name),
    [description, setDescription] = useState(retained?.description ?? template.description),
    [deleteConfirm, setDeleteConfirm] = useState(false),
    [formError, setFormError] = useState('');
  const lifetime = useLifetime(),
    dirty = name !== baseline.name || description !== baseline.description;
  useDirty(dirty, onDirtyChange);
  const captured = useRef(false);
  function save(event: FormEvent) {
    event.preventDefault();
    const parsed = TemplateCommandSchema.safeParse({
      kind: `template.${baseline.kind}.update`,
      templateId: baseline.id,
      revision: baseline.revision,
      input: { name, description },
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'check the template fields.');
      return;
    }
    if (!captured.current && mutate(parsed.data)) {
      captured.current = true;
      onClose();
    }
  }
  function remove() {
    if (
      !captured.current &&
      mutate(
        TemplateCommandSchema.parse({
          kind: `template.${baseline.kind}.delete`,
          templateId: baseline.id,
          revision: baseline.revision,
        }),
      )
    ) {
      captured.current = true;
      onClose();
    }
  }
  async function reviewLatest() {
    try {
      const next = await request<PersonalTemplate>(
        `${baseFor(account.id)}/templates/${baseline.kind}/${encodeURIComponent(baseline.id)}`,
        baseline.kind === 'list' ? ListTemplateSummarySchema : BoardTemplateSummarySchema,
        { signal: lifetime.current.signal },
      );
      setBaseline(next);
      setFormError(
        'latest revision loaded. your name and description draft is retained; compare it before saving.',
      );
    } catch (caught) {
      if (!lifetime.current.signal.aborted) setFormError(errorMessage(caught));
    }
  }
  return (
    <CloseGuard dirty={dirty} busy={false} onClose={onClose}>
      {(close) => (
        <Dialog title={baseline.name} onClose={close} wide>
          <div className="dialog__body templates__form">
            <ServerRecovery />
            <span className="templates__stamp">
              {baseline.kind} template · content v{baseline.contentRevision}
            </span>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                try {
                  void save(event);
                } catch (caught) {
                  setFormError(errorMessage(caught));
                }
              }}
            >
              <fieldset disabled={!localWritable(account)}>
                <label>
                  name
                  <input value={name} onChange={(event) => setName(event.target.value)} required />
                </label>
                <label>
                  description
                  <textarea
                    rows={2}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </label>
              </fieldset>
              {dirty && (
                <footer>
                  <button
                    type="button"
                    onClick={() => {
                      setName(baseline.name);
                      setDescription(baseline.description);
                    }}
                  >
                    reset fields
                  </button>
                  <button type="submit" className="primary" disabled={!localWritable(account)}>
                    save details
                  </button>
                </footer>
              )}
            </form>
            <SourceCounts value={baseline.snapshot} />
            <details className="templates__disclosure">
              <summary>look inside this snapshot</summary>
              <SnapshotContent
                accountId={account.id}
                snapshotId={baseline.snapshot.id}
                applicationDay={accountToday(account.planningZone)}
              />
            </details>
            {(formError || error) && (
              <p className="templates__error" role="alert">
                {formError || error}
              </p>
            )}
            {error && (
              <button className="templates__text" type="button" onClick={() => void reviewLatest()}>
                review latest revision without discarding fields
              </button>
            )}
            <div className="templates__management">
              <button
                type="button"
                disabled={dirty || !providerWritable(account)}
                onClick={() => onApplied(baseline)}
              >
                use template
                <Icon name="arrow" size={14} />
              </button>
              <button
                type="button"
                disabled={dirty || !localWritable(account)}
                onClick={() => onSchedule(baseline)}
              >
                schedule a checklist
                <Icon name="clock" size={14} />
              </button>
              <button
                type="button"
                disabled={dirty || !localWritable(account)}
                onClick={() => onReplace(baseline)}
              >
                replace the saved snapshot
                <Icon name="sync" size={14} />
              </button>
            </div>
            <details className="templates__disclosure">
              <summary>delete template</summary>
              <p>its schedules will pause. existing lists, tasks and captured runs stay intact.</p>
              <label className="templates__check">
                <input
                  type="checkbox"
                  checked={deleteConfirm}
                  onChange={(event) => setDeleteConfirm(event.target.checked)}
                />
                delete this reusable template
              </label>
              <button
                className="templates__danger"
                type="button"
                disabled={!deleteConfirm || !localWritable(account)}
                onClick={() => void remove()}
              >
                delete template
              </button>
            </details>
          </div>
        </Dialog>
      )}
    </CloseGuard>
  );
}
