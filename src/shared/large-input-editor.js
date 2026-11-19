import {
  EditorState, EditorView, Transaction, history, historyKeymap, isolateHistory, keymap, standardKeymap,
} from '../vendor/codemirror.js';
import { hasNonWhitespace } from '../core/text-lines.js';

export function createLargeInputEditor(host, { text, label, onChange }) {
  const extensions = [
    history(),
    keymap.of([...historyKeymap, ...standardKeymap]),
    EditorState.tabSize.of(2),
    EditorView.contentAttributes.of({ 'aria-label': label, dir: 'ltr' }),
    EditorView.domEventHandlers({
      // File drops belong to the pane's JSON importer, including its size and encoding checks.
      drop(event) { return Array.from(event.dataTransfer?.types || []).includes('Files'); },
      // Without a selection CodeMirror otherwise copies or cuts the whole logical line.
      copy(_event, view) { return view.state.selection.main.empty; },
      cut(_event, view) { return view.state.selection.main.empty; },
    }),
    EditorView.updateListener.of((update) => { if (update.docChanged) onChange(); }),
  ];
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: text, extensions }) });

  return {
    setDocument(text) {
      view.setState(EditorState.create({ doc: text, extensions }));
    },
    replace(from, to, text) {
      const insert = view.state.toText(text);
      const selected = view.state.selection.main;
      if (selected.from !== from || selected.to !== to) {
        // Undo restores the original selection, including a selection transferred from the textarea.
        view.dispatch({ selection: { anchor: from, head: to } });
      }
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        annotations: [Transaction.userEvent.of('input.paste'), isolateHistory.of('full')],
        scrollIntoView: true,
      });
    },
    getText() { return view.state.sliceDoc(); },
    hasContent() {
      for (const iter = view.state.doc.iter(); !iter.next().done;) {
        if (hasNonWhitespace(iter.value)) return true;
      }
      return false;
    },
    get length() { return view.state.doc.length; },
    select(start, end) {
      view.dispatch({ selection: { anchor: start, head: end }, scrollIntoView: true });
    },
    focus() { view.focus(); },
    destroy() { view.destroy(); },
  };
}
