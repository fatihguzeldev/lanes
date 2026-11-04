import type { Board } from '../../contracts/board';
import type { Prompt } from '../../../operations/browser/submission/PromptDialog';

type Submit = (
  command: unknown,
  category: 'local' | 'provider',
  identity?: string,
) => Promise<boolean>;

export function createBoardPrompt(submit: Submit): Prompt {
  return {
    title: 'new board',
    label: 'board name',
    initial: '',
    submit: (value, identity) =>
      submit({ kind: 'board.create', input: { title: value } }, 'local', identity),
  };
}

export function createListPrompt(board: Board, submit: Submit): Prompt {
  return {
    title: 'new list',
    label: 'list name',
    initial: '',
    submit: (value, identity) =>
      submit(
        { kind: 'list.create', title: value, boardId: board.id, boardRevision: board.revision },
        'provider',
        identity,
      ),
  };
}

export function deleteBoardPrompt(board: Board, submit: Submit): Prompt {
  return {
    title: `delete ${board.title}?`,
    label: 'type the board name',
    initial: '',
    destructive: true,
    description: 'its lists and tasks will move to your main board. google content is preserved.',
    submit: (value, identity) =>
      value === board.title
        ? submit(
            { kind: 'board.delete', boardId: board.id, revision: board.revision, confirmed: true },
            'local',
            identity,
          )
        : Promise.resolve(false),
  };
}
