import type { DemoTask } from './demo-model';
import type { PlaybackContext } from './playback/playback-clock';
import type { createShowcaseMotion } from './motion/showcase-motion';

type Story = {
  context: PlaybackContext;
  motion: ReturnType<typeof createShowcaseMotion>;
  task(): DemoTask;
  edit(): void;
  notes(value: string): void;
  save(): void;
  view(value: 'list' | 'calendar'): void | Promise<void>;
  completeSubtask(index: number): void;
};

// One task, three views. Holds give each real product action time to read.
export async function playWorkspaceStory(story: Story) {
  const { context, motion } = story;
  const title = '[data-task-id="website"] .details-task__title';
  const notes = '.workbench-editor__notes';
  const save = '.workbench-editor__save';
  const list = '[data-showcase-view-button="list"]';
  const calendar = '[data-showcase-view-button="calendar"]';
  const apply = <T>(action: () => T): T => {
    context.checkpoint();
    return action();
  };

  await context.wait(2000);
  await motion.move(title);
  await context.wait(200);
  await motion.press(title);
  apply(story.edit);
  await context.wait(650);
  await motion.move(notes, { kind: 'text' });
  await context.wait(250);
  const original = story.task().notes;
  const addition = ' ready for launch.';
  for (let length = 1; length <= addition.length; length++) {
    await context.wait(48);
    apply(() => story.notes(original + addition.slice(0, length)));
  }
  await context.wait(650);
  await motion.move(save);
  await motion.press(save);
  apply(story.save);
  await context.wait(1500);

  await motion.move(list);
  await motion.press(list);
  await motion.transition(() => apply(() => story.view('list')), { duration: 680 });
  await context.wait(1300);
  const index = story.task().subtasks.findIndex((child) => !child.completed);
  if (index !== -1) {
    const child = `[data-task-id="website"] .workbench-subtask:nth-child(${index + 1})`;
    await motion.move(child);
    await context.wait(250);
    await motion.press(child);
    apply(() => story.completeSubtask(index));
    await context.wait(1600);
  }

  await motion.move(calendar);
  await motion.press(calendar);
  await motion.transition(() => apply(() => story.view('calendar')), { duration: 780 });
  await context.wait(2800);
  motion.hide();
}
