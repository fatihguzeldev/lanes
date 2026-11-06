import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskCreateExit } from '../useTaskCreateExit';

const hooks = vi.hoisted(() => ({ current: false, effects: [] as Array<() => void> }));
vi.mock('react', () => ({
  useRef: () => hooks,
  useEffect: (effect: () => void) => hooks.effects.push(effect),
}));
function mount() {
  const props = {
    enabled: true,
    dirty: true,
    pending: false,
    submitted: false,
    failed: false,
    onSubmit: vi.fn(() => true),
    onClose: vi.fn(),
  };
  const render = () => {
    hooks.effects = [];
    const close = useTaskCreateExit(props);
    hooks.effects.forEach((effect) => effect());
    return close;
  };
  return { props, render };
}
describe('inline task creation on exit', () => {
  beforeEach(() => {
    hooks.current = false;
    hooks.effects = [];
  });
  it('submits once and dismisses only after admission has a receipt', () => {
    const { props, render } = mount();
    const close = render();
    close();
    close();
    expect(props.onSubmit).toHaveBeenCalledOnce();
    expect(props.onClose).not.toHaveBeenCalled();
    props.pending = true;
    render();
    expect(props.onClose).not.toHaveBeenCalled();
    props.submitted = true;
    render();
    expect(props.onClose).toHaveBeenCalledOnce();
  });
  it('discards a pristine empty entry without creating a task', () => {
    const { props, render } = mount();
    props.dirty = false;
    render()();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledOnce();
  });
  it('keeps invalid input available for correction', () => {
    const { props, render } = mount();
    props.onSubmit.mockReturnValue(false);
    render()();
    expect(props.onClose).not.toHaveBeenCalled();
    props.onSubmit.mockReturnValue(true);
    render()();
    expect(props.onSubmit).toHaveBeenCalledTimes(2);
  });
  it('keeps a failed admission visible and never retries it on another outside click', () => {
    const { props, render } = mount();
    render()();
    props.failed = true;
    render()();
    expect(props.onSubmit).toHaveBeenCalledOnce();
    expect(props.onClose).not.toHaveBeenCalled();
  });
  it('lets an admitted save continue after another close request', () => {
    const { props, render } = mount();
    props.pending = true;
    props.submitted = true;
    render()();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledOnce();
  });
  it('preserves the supplied guarded close for existing-task editing', () => {
    const { props, render } = mount();
    props.enabled = false;
    render()();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});
