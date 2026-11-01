/* Small DOM helpers. No framework — the whole app is a few thousand lines and
 * a build step would cost more than it saves. */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [prop, setting] of Object.entries(value)) {
        // Object.assign silently drops custom properties; they only go
        // through setProperty.
        if (prop.startsWith('--')) node.style.setProperty(prop, setting);
        else node.style[prop] = setting;
      }
    } else {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function button(label, onClick, { class: className = 'btn', ...rest } = {}) {
  return el('button', { class: className, type: 'button', onClick, ...rest }, [label]);
}

/* A labelled slider that reports while dragging. */
export function slider({ label, min, max, step, value, format, onInput }) {
  const readout = el('span', { class: 'slider-value', text: format ? format(value) : String(value) });
  const input = el('input', {
    type: 'range',
    min,
    max,
    step,
    value,
    onInput: (event) => {
      const next = parseFloat(event.target.value);
      readout.textContent = format ? format(next) : String(next);
      onInput(next);
    },
  });
  return el('label', { class: 'slider' }, [
    el('span', { class: 'slider-label' }, [label, readout]),
    input,
  ]);
}

export function field(label, control) {
  return el('label', { class: 'field' }, [el('span', { text: label }), control]);
}

export function section(title, children, actions = null) {
  return el('section', { class: 'panel' }, [
    el('header', { class: 'panel-head' }, [
      el('h2', { text: title }),
      actions,
    ]),
    el('div', { class: 'panel-body' }, children),
  ]);
}

export function formatTime(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
}

/* Replaces window.confirm for destructive actions, so it can be styled and
 * so it never blocks the audio thread. */
export function confirmDialog({ title, body, confirmLabel = 'Continue', danger = true }) {
  return new Promise((resolve) => {
    const close = (answer) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(answer);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
    };
    const backdrop = el('div', { class: 'backdrop', onClick: (e) => { if (e.target === backdrop) close(false); } }, [
      el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, [
        el('h3', { text: title }),
        body ? el('p', { text: body }) : null,
        el('div', { class: 'dialog-actions' }, [
          button('Cancel', () => close(false), { class: 'btn' }),
          button(confirmLabel, () => close(true), { class: danger ? 'btn btn-danger' : 'btn btn-primary' }),
        ]),
      ]),
    ]);
    document.body.appendChild(backdrop);
    document.addEventListener('keydown', onKey);
  });
}
