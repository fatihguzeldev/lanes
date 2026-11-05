import { useState, type ReactNode } from 'react';
import type { Label, TaskFilter, TaskList, TaskSort } from '../../../tasks/contracts/task';
import type { BoardViewPreferences } from './view-preferences';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { Popover } from '../../../../shared/ui/popover/Popover';
import { Select } from '../../../../shared/ui/select/Select';
import { TaskFiltersForm } from './TaskFiltersForm';

import './WorkspaceViewMenu.css';

interface Props {
  trigger?: ReactNode;
  label?: string;
  triggerClassName?: string;
  onBoardOptions?: (anchor: HTMLElement) => void;
  allowLayout: boolean;
  view: BoardViewPreferences['view'];
  sort: TaskSort;
  filter: TaskFilter;
  lists: readonly TaskList[];
  labels: readonly Label[];
  today: string;
  moreLists: boolean;
  moreLabels: boolean;
  onView: (view: BoardViewPreferences['view']) => void;
  onSort: (sort: TaskSort) => void;
  onFilter: (filter: TaskFilter) => void;
  onClear: () => void;
  onMoreLists: () => void;
  onMoreLabels: () => void;
}

export function WorkspaceViewMenu(props: Props) {
  const [filtering, setFiltering] = useState(false);
  const filtered = Object.keys(props.filter).length > 0;
  const label = props.label ?? 'view options';
  return (
    <Popover
      label={`${label}${filtered ? ', filters active' : ''}`}
      trigger={
        <>
          {props.trigger ?? <Icon name="filter" size={16} />}
          {filtered && <span className="workspace-view-menu__filter-dot" aria-hidden="true" />}
        </>
      }
      triggerClassName={`workspace-view-menu__trigger${props.trigger ? ' workspace-view-menu__trigger--custom' : ''}${props.triggerClassName ? ` ${props.triggerClassName}` : ''}`}
      className="workspace-view-menu"
      align="end"
    >
      {(close, anchor) =>
        filtering ? (
          <div className="workspace-view-menu__filters">
            <button className="popover__item" onClick={() => setFiltering(false)}>
              <Icon name="left" size={14} /> view options
            </button>
            <TaskFiltersForm
              {...props}
              onChange={props.onFilter}
              onClear={props.onClear}
              onClose={() => {
                setFiltering(false);
                close();
              }}
            />
          </div>
        ) : (
          <div className="workspace-view-menu__body">
            {props.allowLayout && (
              <label>
                layout
                <Select
                  aria-label="layout"
                  value={props.view}
                  onChange={(value) => props.onView(value as Props['view'])}
                  options={[
                    { value: 'board', label: 'board' },
                    { value: 'list', label: 'list' },
                    { value: 'calendar', label: 'calendar' },
                    ...(props.view === 'completed'
                      ? [{ value: 'completed', label: 'completed tasks' }]
                      : []),
                  ]}
                />
              </label>
            )}
            <label>
              sort by
              <Select
                aria-label="sort by"
                value={props.sort}
                onChange={(value) => props.onSort(value as TaskSort)}
                options={[
                  { value: 'manual', label: 'your order' },
                  { value: 'scheduled', label: 'date' },
                  { value: 'priority', label: 'priority' },
                  { value: 'title', label: 'title' },
                  { value: 'updated', label: 'last updated' },
                ]}
              />
            </label>
            <button className="popover__item" onClick={() => setFiltering(true)}>
              <Icon name="filter" size={15} /> filter tasks <Icon name="right" size={14} />
            </button>
            {filtered && (
              <button className="popover__item" onClick={props.onClear}>
                clear filters
              </button>
            )}
            {props.onBoardOptions && (
              <div className="workspace-view-menu__board">
                <button
                  className="popover__item"
                  onClick={() => {
                    close();
                    props.onBoardOptions?.(anchor);
                  }}
                >
                  <Icon name="settings" size={15} /> board options
                  <Icon name="right" size={14} />
                </button>
              </div>
            )}
          </div>
        )
      }
    </Popover>
  );
}
