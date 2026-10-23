// Check's sentences highlighted in the note: CodeMirror marks, set with an effect and dropped on any edit.
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin } from '@codemirror/view';
import type { Mark } from './marks.ts';

export const setMarks = StateEffect.define<Mark[]>();

const marksField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(marks, tr) {
		for (const e of tr.effects) {
			if (e.is(setMarks)) {
				return Decoration.set(e.value.map((m) => Decoration.mark({
					class: `p3n-mark p3n-mark-${m.kind}`,
					attributes: m.why ? { title: m.why } : {},
				}).range(m.from, m.to)), true);
			}
		}
		return tr.docChanged ? Decoration.none : marks;
	},
	provide: (f) => EditorView.decorations.from(f),
});

export const hasMarks = (view: EditorView) => view.state.field(marksField, false)?.size ? true : false;

// The field, a register of the open editors (to find the one a check came from), and a call when an edit
// drops the marks.
export function highlightExtension(views: Set<EditorView>, onDropped: (view: EditorView) => void) {
	return [
		marksField,
		ViewPlugin.define((view) => {
			views.add(view);
			return { destroy: () => views.delete(view) };
		}),
		EditorView.updateListener.of((u) => {
			if (u.startState.field(marksField, false)?.size && !hasMarks(u.view)) onDropped(u.view);
		}),
	];
}
