import type { Board } from '../../contracts/board';
import type { Prompt } from '../../../operations/browser/submission/PromptDialog';

type Submit = (
  command: unknown,
  category: 'local' | 'provider',
  identity?: string,
) => Promise<boolean>;

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
