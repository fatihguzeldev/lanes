import type { TemplateDocument } from '../tasks/template-contract';
import type { z } from 'zod';
import type { BoardTemplateAppearanceSchema } from './template-contract';
export const boardTemplateGallery: readonly {
  id: string;
  name: string;
  description: string;
  appearance: z.infer<typeof BoardTemplateAppearanceSchema>;
  document: TemplateDocument;
}[] = [
  {
    id: 'a-place-for-things',
    name: 'a place for things',
    description: 'three small lists to settle into.',
    appearance: { title: 'a place for things', emoji: '🌱', color: '#e5e7db', backgroundUrl: null },
    document: {
      header: {
        schemaVersion: 1,
        dateMode: 'none',
        saveDay: '2026-01-01',
        zone: 'UTC',
        listCount: 3,
        taskCount: 3,
      },
      lists: [
        { key: 'now', title: 'a little now', color: '#9aa886', position: 0 },
        { key: 'later', title: 'some room later', color: '#b49a7f', position: 1 },
        { key: 'someday', title: 'someday, maybe', color: '#a9a9bb', position: 2 },
      ],
      tasks: [
        {
          key: 'one',
          listKey: 'now',
          parentKey: null,
          position: 0,
          title: 'pick something small to begin',
          notes: '',
          dayOffset: null,
          scheduledTime: null,
          timeZone: null,
          repeatPreset: null,
          labels: [],
          priority: 'none',
          starred: false,
          dependencyKeys: [],
        },
        {
          key: 'two',
          listKey: 'later',
          parentKey: null,
          position: 1,
          title: 'leave a note for later',
          notes: '',
          dayOffset: null,
          scheduledTime: null,
          timeZone: null,
          repeatPreset: null,
          labels: [],
          priority: 'none',
          starred: false,
          dependencyKeys: [],
        },
        {
          key: 'three',
          listKey: 'someday',
          parentKey: null,
          position: 2,
          title: 'keep an idea here',
          notes: '',
          dayOffset: null,
          scheduledTime: null,
          timeZone: null,
          repeatPreset: null,
          labels: [],
          priority: 'none',
          starred: false,
          dependencyKeys: [],
        },
      ],
    },
  },
];
