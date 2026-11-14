export function span(className, text) {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

export { createChildPathIndex } from '../core/json-path.js';
