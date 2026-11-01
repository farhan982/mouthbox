/* Bottom tab bar. Thumb-reachable, because this gets used standing up with
 * headphones on. */

import * as state from '../state.js';
import { el } from './ui.js';

const TABS = [
  { id: 'record', label: 'Record' },
  { id: 'pads', label: 'Pads' },
  { id: 'steps', label: 'Steps' },
  { id: 'song', label: 'Song' },
];

export function buildNav(active) {
  return el('nav', { class: 'nav' }, TABS.map((tab) => el('button', {
    class: `nav-item${active === tab.id ? ' is-active' : ''}`,
    type: 'button',
    onClick: () => state.setUi({ tab: tab.id }),
  }, [tab.label])));
}
